use pebble_core::{Account, PebbleError, ProviderType, Result};
use rusqlite::{self, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::Store;

pub fn normalize_account_label(label: Option<&str>) -> Result<Option<String>> {
    let Some(label) = label else {
        return Ok(None);
    };
    if label.chars().any(char::is_control) || label.chars().count() > 120 {
        return Err(PebbleError::Validation(
            "Account label must be at most 120 characters and contain no control characters".into(),
        ));
    }
    Ok((!label.trim().is_empty()).then(|| label.trim().to_owned()))
}

/// Rewrite `sort_order` so the accounts follow `ordered_ids`.
///
/// Callers hand over a whole list in display order rather than a single move
/// because that is the only shape that cannot tear: one transaction either
/// writes the new order or leaves the old one untouched.
///
/// The list is treated as a preference, not a contract. Ids that no longer
/// exist are dropped and duplicates collapse to their first mention, so a
/// settings panel that went stale — an account was added or removed in another
/// window — still saves instead of failing the user's click. Accounts the list
/// does not mention keep their previous relative order behind the mentioned
/// ones, which is what a partial list means in practice.
pub(crate) fn apply_account_order(conn: &Connection, ordered_ids: &[String]) -> Result<()> {
    let existing: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM accounts ORDER BY sort_order ASC, created_at ASC, id ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        ids
    };

    let known: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let mut ordered: Vec<String> = Vec::with_capacity(existing.len());
    for id in ordered_ids {
        if known.contains(id.as_str()) && !ordered.iter().any(|kept| kept == id) {
            ordered.push(id.clone());
        }
    }
    let mut unmentioned: Vec<String> = Vec::new();
    for id in existing {
        if !ordered.contains(&id) {
            unmentioned.push(id);
        }
    }
    ordered.extend(unmentioned);

    for (position, id) in ordered.iter().enumerate() {
        conn.execute(
            "UPDATE accounts SET sort_order = ?1 WHERE id = ?2",
            rusqlite::params![position as i32, id],
        )?;
    }

    Ok(())
}

/// Typed view over an account's `sync_state` JSON blob.
///
/// The column itself remains a flexible JSON object on disk (so provider
/// implementations can tuck their own bookkeeping under `extra` without a
/// migration), but every known field has an explicit name and type here.
/// Callers should go through [`Store::get_sync_state`] and
/// [`Store::update_sync_state`] rather than parsing raw JSON, so that
/// read-modify-write cycles don't clobber sibling fields by accident.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncState {
    /// Provider slug as persisted: `"gmail"`, `"outlook"`, `"imap"`, or `"pop3"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,

    /// Last sync cursor — opaque to the store; interpreted by the provider
    /// (e.g. IMAP UID + modseq, Gmail historyId, Outlook deltaLink).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_cursor: Option<String>,

    /// Legacy inline IMAP config, present on accounts that predate the move
    /// of credentials into `auth_data`. New accounts should not populate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap: Option<serde_json::Value>,

    /// Legacy inline SMTP config, same provenance as `imap`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp: Option<serde_json::Value>,

    /// Explicit IMAP mailbox selection, stored as provider remote IDs.
    ///
    /// `None` preserves the legacy behaviour of syncing every selectable
    /// mailbox. `Some(...)` enables account-level selection; Inbox is always
    /// included by the IMAP worker even when it is absent from this list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_imap_folder_remote_ids: Option<Vec<String>>,

    /// Any fields we don't yet model — preserved verbatim on write so
    /// round-tripping through [`Store::update_sync_state`] never drops data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl SyncState {
    /// Parse a `sync_state` JSON string into a typed `SyncState`.
    /// An empty or `None` column is treated as [`SyncState::default`].
    pub fn from_json_opt(raw: Option<&str>) -> Result<Self> {
        match raw {
            None => Ok(Self::default()),
            Some(s) if s.trim().is_empty() => Ok(Self::default()),
            Some(s) => serde_json::from_str(s)
                .map_err(|e| PebbleError::Storage(format!("Invalid sync_state JSON: {e}"))),
        }
    }

    /// Serialize back to the JSON string format stored in the DB.
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self)
            .map_err(|e| PebbleError::Storage(format!("Failed to serialize sync_state: {e}")))
    }
}

fn provider_to_str(p: &ProviderType) -> &'static str {
    match p {
        ProviderType::Imap => "imap",
        ProviderType::Pop3 => "pop3",
        ProviderType::Gmail => "gmail",
        ProviderType::Outlook => "outlook",
    }
}

fn str_to_provider(s: &str) -> ProviderType {
    match s {
        "pop3" => ProviderType::Pop3,
        "gmail" => ProviderType::Gmail,
        "outlook" => ProviderType::Outlook,
        _ => ProviderType::Imap,
    }
}

impl Store {
    pub fn insert_account(&self, account: &Account) -> Result<()> {
        let account_label = normalize_account_label(account.account_label.as_deref())?;
        self.with_write(|conn| {
            // A new account joins the end of the user's order. Leaving it at the
            // column default would push it to the front of the sidebar and make
            // it the account the next message is composed from.
            conn.execute(
                "INSERT INTO accounts (id, email, display_name, color, provider, created_at, updated_at, account_label, provider_display_name, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                         (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM accounts))",
                rusqlite::params![
                    account.id,
                    account.email,
                    account.display_name,
                    account.color.as_deref(),
                    provider_to_str(&account.provider),
                    account.created_at,
                    account.updated_at,
                    account_label,
                    account.provider_display_name.as_deref(),
                ],
            )?;
            Ok(())
        })
    }

    /// Persist the user's account order. See [`apply_account_order`].
    pub fn reorder_accounts(&self, account_ids: &[String]) -> Result<()> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            apply_account_order(&tx, account_ids)?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn update_account(
        &self,
        id: &str,
        email: &str,
        display_name: &str,
        color: Option<&str>,
    ) -> Result<()> {
        self.update_account_fields(id, email, display_name, color, None)
    }

    pub fn update_account_details(
        &self,
        id: &str,
        email: &str,
        display_name: &str,
        color: Option<&str>,
        label: Option<&str>,
    ) -> Result<()> {
        self.update_account_fields(id, email, display_name, color, Some(label))
    }

    fn update_account_fields(
        &self,
        id: &str,
        email: &str,
        display_name: &str,
        color: Option<&str>,
        label: Option<Option<&str>>,
    ) -> Result<()> {
        let normalized_label = normalize_account_label(label.flatten())?;
        self.with_write(|conn| {
            let (old_email, provider): (String, String) = conn.query_row(
                "SELECT email, provider FROM accounts WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if matches!(provider.as_str(), "gmail" | "outlook")
                && !old_email.eq_ignore_ascii_case(email.trim())
            {
                return Err(PebbleError::Validation(
                    "OAuth mailbox addresses must be changed through mailbox verification".into(),
                ));
            }
            let now = pebble_core::now_timestamp();
            conn.execute(
                "UPDATE accounts SET email = ?1, display_name = ?2, color = ?3, updated_at = ?4,
                 account_label = CASE WHEN ?6 THEN ?7 ELSE account_label END WHERE id = ?5",
                rusqlite::params![
                    email.trim(),
                    display_name,
                    color,
                    now,
                    id,
                    label.is_some(),
                    normalized_label
                ],
            )?;
            Ok(())
        })
    }

    /// Bind a live OAuth identity without touching messages, credentials or user labels.
    /// An existing subject is never silently rebound, including after backup restore.
    pub fn apply_verified_oauth_identity(
        &self,
        id: &str,
        expected_email: &str,
        identity: &pebble_core::OAuthMailboxIdentity,
        allow_address_change: bool,
    ) -> Result<()> {
        if identity.subject.trim().is_empty() || identity.email.trim().is_empty() {
            return Err(PebbleError::Validation(
                "Mailbox identity is incomplete".into(),
            ));
        }
        self.with_write(|conn| {
            let (email, provider, subject): (String, String, Option<String>) = conn.query_row(
                "SELECT email, provider, oauth_subject FROM accounts WHERE id = ?1", [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            if !matches!(provider.as_str(), "gmail" | "outlook") || email != expected_email {
                return Err(PebbleError::Validation("Account changed during mailbox verification. Refresh and try again.".into()));
            }
            if subject.as_deref().is_some_and(|old| old != identity.subject) {
                return Err(PebbleError::Validation("The authorization belongs to a different mailbox identity. Reconnect the original account.".into()));
            }
            let address_changed = !email.eq_ignore_ascii_case(&identity.email);
            if address_changed && !allow_address_change {
                return Err(PebbleError::Validation("The saved address differs from the authorized mailbox. Verify the mailbox in account settings before sending.".into()));
            }
            if address_changed {
                let duplicate: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM accounts WHERE id != ?1 AND provider = ?2 AND lower(email) = lower(?3))",
                    rusqlite::params![id, provider, identity.email], |row| row.get(0))?;
                if duplicate { return Err(PebbleError::Validation("This mailbox is already present in another account. No accounts were merged.".into())); }
            }
            conn.execute("UPDATE accounts SET email = ?1, oauth_subject = ?2, provider_display_name = ?3, updated_at = ?4 WHERE id = ?5",
                rusqlite::params![identity.email, identity.subject, identity.display_name, pebble_core::now_timestamp(), id])?;
            Ok(())
        })
    }

    pub fn get_account(&self, id: &str) -> Result<Option<Account>> {
        self.with_read(|conn| {
            let result = conn
                .query_row(
                    "SELECT id, email, display_name, color, provider, created_at, updated_at, account_label, provider_display_name
                     FROM accounts WHERE id = ?1",
                    rusqlite::params![id],
                    |row| {
                        Ok(Account {
                            account_label: row.get(7)?,
                            provider_display_name: row.get(8)?,
                            id: row.get(0)?,
                            email: row.get(1)?,
                            display_name: row.get(2)?,
                            color: row.get(3)?,
                            provider: str_to_provider(&row.get::<_, String>(4)?),
                            created_at: row.get(5)?,
                            updated_at: row.get(6)?,
                        })
                    },
                )
                .optional()?;
            Ok(result)
        })
    }

    /// Every account, in the order the user arranged them.
    ///
    /// The first entry is the app's default sender — the address a new message
    /// goes out from while the combined "all accounts" mailbox is selected — so
    /// this order is a preference, not a display detail. `created_at` and `id`
    /// only break ties left behind by a row that never got a position.
    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, email, display_name, color, provider, created_at, updated_at, account_label, provider_display_name
                     FROM accounts ORDER BY sort_order ASC, created_at ASC, id ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(Account {
                    account_label: row.get(7)?,
                    provider_display_name: row.get(8)?,
                    id: row.get(0)?,
                    email: row.get(1)?,
                    display_name: row.get(2)?,
                    color: row.get(3)?,
                    provider: str_to_provider(&row.get::<_, String>(4)?),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?;
            let mut accounts = Vec::new();
            for row in rows {
                accounts.push(row?);
            }
            Ok(accounts)
        })
    }

    pub fn delete_account(&self, id: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute("DELETE FROM accounts WHERE id = ?1", rusqlite::params![id])?;
            Ok(())
        })
    }

    pub fn update_account_sync_state(&self, account_id: &str, sync_state: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "UPDATE accounts SET sync_state = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![sync_state, pebble_core::now_timestamp(), account_id],
            )?;
            Ok(())
        })
    }

    pub fn get_account_sync_state(&self, account_id: &str) -> Result<Option<String>> {
        self.with_read(|conn| {
            let result = conn.query_row(
                "SELECT sync_state FROM accounts WHERE id = ?1",
                rusqlite::params![account_id],
                |row| row.get::<_, Option<String>>(0),
            )?;
            Ok(result)
        })
    }

    /// Read the `sync_state` column as a typed [`SyncState`].
    ///
    /// Missing column or empty string returns [`SyncState::default`]. The
    /// account must exist; a missing account row returns `Ok(None)`.
    pub fn get_sync_state(&self, account_id: &str) -> Result<Option<SyncState>> {
        self.with_read(|conn| {
            let row: Option<Option<String>> = conn
                .query_row(
                    "SELECT sync_state FROM accounts WHERE id = ?1",
                    rusqlite::params![account_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?;
            match row {
                None => Ok(None),
                Some(raw) => Ok(Some(SyncState::from_json_opt(raw.as_deref())?)),
            }
        })
    }

    /// Read-modify-write the `sync_state` column safely.
    ///
    /// The closure receives the current state (default if missing) and may
    /// mutate any fields; unknown fields in `extra` are preserved so we
    /// never drop data we don't yet model. Runs inside a single write txn.
    pub fn update_sync_state<F>(&self, account_id: &str, f: F) -> Result<()>
    where
        F: FnOnce(&mut SyncState),
    {
        self.with_write(|conn| {
            let current: Option<String> = conn
                .query_row(
                    "SELECT sync_state FROM accounts WHERE id = ?1",
                    rusqlite::params![account_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            let mut state = SyncState::from_json_opt(current.as_deref())?;
            f(&mut state);
            let new_json = state.to_json()?;
            let now = pebble_core::now_timestamp();
            conn.execute(
                "UPDATE accounts SET sync_state = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![new_json, now, account_id],
            )?;
            Ok(())
        })
    }

    /// Get the sync cursor for an account. Thin wrapper over [`get_sync_state`].
    pub fn get_sync_cursor(&self, account_id: &str) -> Result<Option<String>> {
        Ok(self
            .get_sync_state(account_id)?
            .and_then(|s| s.last_sync_cursor))
    }

    /// Set the sync cursor in the sync_state JSON without clobbering other fields.
    pub fn set_sync_cursor(&self, account_id: &str, cursor: &str) -> Result<()> {
        self.update_sync_state(account_id, |s| {
            s.last_sync_cursor = Some(cursor.to_string());
        })
    }

    pub fn get_folder_sync_state(
        &self,
        account_id: &str,
        folder_id: &str,
    ) -> Result<Option<String>> {
        self.with_read(|conn| {
            let state = conn
                .query_row(
                    "SELECT state FROM folder_sync_state
                     WHERE account_id = ?1 AND folder_id = ?2",
                    rusqlite::params![account_id, folder_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            Ok(state)
        })
    }

    pub fn set_folder_sync_state(
        &self,
        account_id: &str,
        folder_id: &str,
        state: &str,
    ) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "INSERT INTO folder_sync_state (account_id, folder_id, state, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(account_id, folder_id) DO UPDATE SET
                    state = excluded.state,
                    updated_at = excluded.updated_at",
                rusqlite::params![account_id, folder_id, state, pebble_core::now_timestamp()],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod cursor_tests {
    use crate::Store;
    use pebble_core::*;

    #[test]
    fn verified_mailbox_repair_preserves_account_data_and_rejects_rebinding() {
        let store = Store::open_in_memory().unwrap();
        let mut account = test_account();
        account.provider = ProviderType::Outlook;
        account.account_label = Some("公司内部".into());
        store.insert_account(&account).unwrap();
        store.set_auth_data(&account.id, b"original-auth").unwrap();
        store
            .set_sync_cursor(&account.id, "original-cursor")
            .unwrap();
        let mut identity = OAuthMailboxIdentity {
            subject: "outlook:stable-a".into(),
            email: "mailbox@outlook.com".into(),
            display_name: Some("服务端姓名".into()),
        };
        assert!(store
            .apply_verified_oauth_identity(&account.id, &account.email, &identity, false)
            .is_err());
        store
            .apply_verified_oauth_identity(&account.id, &account.email, &identity, true)
            .unwrap();
        let repaired = store.get_account(&account.id).unwrap().unwrap();
        assert_eq!(repaired.account_label, account.account_label);
        assert_eq!(repaired.display_name, account.display_name);
        assert_eq!(repaired.provider_display_name, identity.display_name);
        assert_eq!(
            store.get_auth_data(&account.id).unwrap().unwrap(),
            b"original-auth"
        );
        assert_eq!(
            store.get_sync_cursor(&account.id).unwrap().as_deref(),
            Some("original-cursor")
        );
        identity.subject = "outlook:another-mailbox".into();
        assert!(store
            .apply_verified_oauth_identity(&account.id, &repaired.email, &identity, true)
            .is_err());
        assert_eq!(
            store.get_account(&account.id).unwrap().unwrap().email,
            repaired.email
        );
    }

    #[test]
    fn backup_restore_cannot_replace_a_connected_oauth_mailbox() {
        use crate::cloud_sync::{RestoredAuthData, RestoredPrivateData};
        let store = Store::open_in_memory().unwrap();
        let mut account = test_account();
        account.provider = ProviderType::Gmail;
        store.insert_account(&account).unwrap();
        store.set_auth_data(&account.id, b"original-auth").unwrap();
        let mut backup: serde_json::Value =
            serde_json::from_slice(&store.export_settings().unwrap()).unwrap();
        backup["accounts"][0]["email"] = serde_json::json!("other@example.com");
        backup["accounts"][0]["account_label"] = serde_json::json!("Restored label");
        let bytes = serde_json::to_vec(&backup).unwrap();
        store.import_settings(&bytes).unwrap();
        assert_eq!(
            store.get_account(&account.id).unwrap().unwrap().email,
            account.email
        );
        store
            .import_settings_with_private_data(
                &bytes,
                RestoredPrivateData {
                    auth_data: vec![RestoredAuthData {
                        account_id: account.id.clone(),
                        provider: "gmail".into(),
                        encrypted: b"different-auth".to_vec(),
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        let loaded = store.get_account(&account.id).unwrap().unwrap();
        assert_eq!(loaded.email, account.email);
        assert_eq!(loaded.account_label.as_deref(), Some("Restored label"));
        assert_eq!(
            store.get_auth_data(&account.id).unwrap().unwrap(),
            b"original-auth"
        );
    }

    #[test]
    fn label_can_be_cleared_without_changing_sender_or_credentials() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        store
            .update_account_details(
                &account.id,
                &account.email,
                &account.display_name,
                None,
                Some("  Work  "),
            )
            .unwrap();
        assert_eq!(
            store
                .get_account(&account.id)
                .unwrap()
                .unwrap()
                .account_label
                .as_deref(),
            Some("Work")
        );
        store
            .update_account_details(
                &account.id,
                &account.email,
                &account.display_name,
                None,
                Some("   "),
            )
            .unwrap();
        let loaded = store.get_account(&account.id).unwrap().unwrap();
        assert!(loaded.account_label.is_none());
        assert_eq!(loaded.sender_identity().name.as_deref(), Some("Test"));
    }

    #[test]
    fn oauth_metadata_edit_cannot_change_mailbox_address() {
        let store = Store::open_in_memory().unwrap();
        let mut account = test_account();
        account.provider = ProviderType::Outlook;
        store.insert_account(&account).unwrap();
        assert!(store
            .update_account(&account.id, "other@example.com", "Test", None)
            .is_err());
        assert_eq!(
            store.get_account(&account.id).unwrap().unwrap().email,
            account.email
        );
    }

    #[test]
    fn account_label_survives_storage_and_backup_without_changing_sender() {
        let store = Store::open_in_memory().unwrap();
        let mut value = serde_json::to_value(test_account()).unwrap();
        value["account_label"] = serde_json::json!("公司内部备用");
        let account: Account = serde_json::from_value(value).unwrap();
        store.insert_account(&account).unwrap();
        let loaded = store.get_account(&account.id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&loaded).unwrap()["account_label"],
            "公司内部备用"
        );
        assert_eq!(loaded.display_name, "Test");
        assert_eq!(loaded.email, "test@example.com");

        let restored = Store::open_in_memory().unwrap();
        restored
            .import_settings(&store.export_settings().unwrap())
            .unwrap();
        let restored_account = restored.get_account(&account.id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&restored_account).unwrap()["account_label"],
            "公司内部备用"
        );
        assert_eq!(restored_account.display_name, "Test");
    }

    fn test_account() -> Account {
        Account {
            account_label: None,
            provider_display_name: None,
            id: new_id(),
            email: "test@example.com".to_string(),
            display_name: "Test".to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        }
    }

    #[test]
    fn test_set_and_get_sync_cursor() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();

        store.set_sync_cursor(&account.id, "12345").unwrap();
        let cursor = store.get_sync_cursor(&account.id).unwrap();
        assert_eq!(cursor, Some("12345".to_string()));
    }

    #[test]
    fn test_get_sync_cursor_returns_none() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();

        let cursor = store.get_sync_cursor(&account.id).unwrap();
        assert!(cursor.is_none());
    }

    #[test]
    fn test_set_cursor_preserves_other_fields() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();

        // Set initial sync_state with some data
        store
            .update_account_sync_state(&account.id, r#"{"provider":"imap","foo":"bar"}"#)
            .unwrap();

        // Set cursor
        store.set_sync_cursor(&account.id, "999").unwrap();

        // Verify cursor is set
        let cursor = store.get_sync_cursor(&account.id).unwrap();
        assert_eq!(cursor, Some("999".to_string()));

        // Verify other fields preserved
        let state = store.get_account_sync_state(&account.id).unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(&state).unwrap();
        assert_eq!(value["foo"], "bar");
        assert_eq!(value["provider"], "imap");
    }

    #[test]
    fn test_account_color_is_persisted_and_updated() {
        let store = Store::open_in_memory().unwrap();
        let mut account = test_account();
        account.color = Some("#22c55e".to_string());
        store.insert_account(&account).unwrap();

        let loaded = store.get_account(&account.id).unwrap().unwrap();
        assert_eq!(loaded.color.as_deref(), Some("#22c55e"));

        store
            .update_account(
                &account.id,
                "renamed@example.com",
                "Renamed",
                Some("#f97316"),
            )
            .unwrap();

        let updated = store.get_account(&account.id).unwrap().unwrap();
        assert_eq!(updated.email, "renamed@example.com");
        assert_eq!(updated.color.as_deref(), Some("#f97316"));
    }

    /// Accounts are compared by id only; `created_at` is deliberately identical
    /// so a test can never pass because of a timestamp tie-break.
    fn account_with_id(id: &str) -> Account {
        Account {
            account_label: Some(id.to_string()),
            provider_display_name: None,
            id: id.to_string(),
            email: format!("{id}@example.com"),
            display_name: id.to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn ordered_ids(store: &Store) -> Vec<String> {
        store
            .list_accounts()
            .unwrap()
            .into_iter()
            .map(|account| account.id)
            .collect()
    }

    #[test]
    fn a_new_account_joins_the_end_of_the_user_order() {
        let store = Store::open_in_memory().unwrap();
        for id in ["first", "second"] {
            store.insert_account(&account_with_id(id)).unwrap();
        }
        store
            .reorder_accounts(&["second".into(), "first".into()])
            .unwrap();

        store.insert_account(&account_with_id("third")).unwrap();

        assert_eq!(ordered_ids(&store), ["second", "first", "third"]);
    }

    #[test]
    fn reorder_accounts_persists_the_given_order() {
        let store = Store::open_in_memory().unwrap();
        for id in ["a", "b", "c"] {
            store.insert_account(&account_with_id(id)).unwrap();
        }

        store
            .reorder_accounts(&["c".into(), "a".into(), "b".into()])
            .unwrap();

        assert_eq!(ordered_ids(&store), ["c", "a", "b"]);

        // The stored positions are what persist; the list order is derived from
        // them, so assert the column itself rather than the same query twice.
        let positions: Vec<i32> = store
            .with_read(|conn| {
                let mut stmt = conn.prepare("SELECT sort_order FROM accounts ORDER BY id ASC")?;
                let rows = stmt.query_map([], |row| row.get::<_, i32>(0))?;
                let mut values = Vec::new();
                for row in rows {
                    values.push(row?);
                }
                Ok(values)
            })
            .unwrap();
        assert_eq!(positions, [1, 2, 0]);
    }

    #[test]
    fn reorder_treats_a_stale_list_as_a_preference() {
        let store = Store::open_in_memory().unwrap();
        for id in ["a", "b", "c"] {
            store.insert_account(&account_with_id(id)).unwrap();
        }

        // "b" is repeated, "ghost" was deleted in another window, and "c" is
        // missing entirely — the same shape a settings panel goes stale in.
        store
            .reorder_accounts(&["b".into(), "ghost".into(), "b".into(), "a".into()])
            .unwrap();

        // Mentioned accounts come first in the order given; the one the caller
        // forgot keeps its place behind them instead of failing the save.
        assert_eq!(ordered_ids(&store), ["b", "a", "c"]);
    }

    #[test]
    fn reorder_with_an_empty_list_leaves_the_order_alone() {
        let store = Store::open_in_memory().unwrap();
        for id in ["a", "b"] {
            store.insert_account(&account_with_id(id)).unwrap();
        }

        store.reorder_accounts(&[]).unwrap();

        assert_eq!(ordered_ids(&store), ["a", "b"]);
    }

    #[test]
    fn backup_round_trip_keeps_the_account_order() {
        let store = Store::open_in_memory().unwrap();
        for id in ["a", "b", "c"] {
            store.insert_account(&account_with_id(id)).unwrap();
        }
        store
            .reorder_accounts(&["c".into(), "b".into(), "a".into()])
            .unwrap();

        let restored = Store::open_in_memory().unwrap();
        restored
            .import_settings(&store.export_settings().unwrap())
            .unwrap();

        assert_eq!(ordered_ids(&restored), ["c", "b", "a"]);
    }

    #[test]
    fn restoring_a_partial_backup_puts_its_accounts_first_without_ties() {
        let store = Store::open_in_memory().unwrap();
        for id in ["a", "b", "c"] {
            store.insert_account(&account_with_id(id)).unwrap();
        }
        store
            .reorder_accounts(&["c".into(), "b".into(), "a".into()])
            .unwrap();

        // A backup that only knows about "a", restored onto a machine that
        // already holds all three: the accounts the file does not mention must
        // keep their relative order behind it, and no two rows may end up
        // sharing a position.
        let mut backup: serde_json::Value =
            serde_json::from_slice(&store.export_settings().unwrap()).unwrap();
        backup["accounts"]
            .as_array_mut()
            .unwrap()
            .retain(|account| account["id"] == "a");

        store
            .import_settings(&serde_json::to_vec(&backup).unwrap())
            .unwrap();

        assert_eq!(ordered_ids(&store), ["a", "c", "b"]);
    }
}

#[cfg(test)]
mod folder_sync_state_tests {
    use crate::Store;
    use pebble_core::*;

    fn test_account() -> Account {
        Account {
            account_label: None,
            provider_display_name: None,
            id: new_id(),
            email: "test@example.com".to_string(),
            display_name: "Test".to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        }
    }

    fn test_folder(account_id: &str, remote_id: &str, role: FolderRole, sort_order: i32) -> Folder {
        Folder {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: remote_id.to_string(),
            name: remote_id.to_string(),
            folder_type: FolderType::Folder,
            role: Some(role),
            parent_id: None,
            color: None,
            is_system: true,
            sort_order,
        }
    }

    #[test]
    fn folder_sync_state_is_scoped_by_account_and_folder() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let inbox = test_folder(&account.id, "INBOX", FolderRole::Inbox, 0);
        let sent = test_folder(&account.id, "Sent", FolderRole::Sent, 1);
        store.insert_folder(&inbox).unwrap();
        store.insert_folder(&sent).unwrap();

        store
            .set_folder_sync_state(&account.id, &inbox.id, r#"{"last_uid":10}"#)
            .unwrap();
        store
            .set_folder_sync_state(&account.id, &sent.id, r#"{"last_uid":20}"#)
            .unwrap();

        assert_eq!(
            store.get_folder_sync_state(&account.id, &inbox.id).unwrap(),
            Some(r#"{"last_uid":10}"#.to_string())
        );
        assert_eq!(
            store.get_folder_sync_state(&account.id, &sent.id).unwrap(),
            Some(r#"{"last_uid":20}"#.to_string())
        );
    }

    #[test]
    fn folder_sync_state_returns_none_when_missing() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let inbox = test_folder(&account.id, "INBOX", FolderRole::Inbox, 0);
        store.insert_folder(&inbox).unwrap();

        assert_eq!(
            store.get_folder_sync_state(&account.id, &inbox.id).unwrap(),
            None
        );
    }
}
