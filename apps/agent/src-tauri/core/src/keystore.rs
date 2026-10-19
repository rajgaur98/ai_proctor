//! Secrets kept in the OS keychain: the outbox encryption key, the refresh token,
//! a pending PKCE verifier. Production uses `agent-platform`'s keychain; tests use
//! `MemoryKeyStore`.

use std::sync::Mutex;

pub const KEY_LEN: usize = 32;
pub type Key = [u8; KEY_LEN];

#[derive(Debug, thiserror::Error)]
pub enum KeyStoreError {
    #[error("keychain unavailable: {0}")]
    Unavailable(String),
    #[error("stored key is corrupt")]
    Corrupt,
}

pub trait KeyStore: Send + Sync {
    /// The secret under `name`, or `None` if it was never stored.
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, KeyStoreError>;
    fn set(&self, name: &str, secret: &[u8]) -> Result<(), KeyStoreError>;
    /// Removes the secret; a missing one is not an error.
    fn delete(&self, name: &str) -> Result<(), KeyStoreError>;
}

/// Returns the 32-byte key under `name`, creating and storing a random one on
/// first run.
pub fn get_or_create(store: &dyn KeyStore, name: &str) -> Result<Key, KeyStoreError> {
    if let Some(bytes) = store.get(name)? {
        return bytes.try_into().map_err(|_| KeyStoreError::Corrupt);
    }
    let mut key = [0u8; KEY_LEN];
    getrandom::fill(&mut key).map_err(|e| KeyStoreError::Unavailable(e.to_string()))?;
    store.set(name, &key)?;
    Ok(key)
}

/// In-memory store for tests; can be switched to fail like a locked keychain.
#[derive(Default)]
pub struct MemoryKeyStore {
    secrets: Mutex<std::collections::HashMap<String, Vec<u8>>>,
    unavailable: Mutex<bool>,
}

impl MemoryKeyStore {
    pub fn set_unavailable(&self, unavailable: bool) {
        *self.unavailable.lock().unwrap() = unavailable;
    }

    fn check(&self) -> Result<(), KeyStoreError> {
        if *self.unavailable.lock().unwrap() {
            return Err(KeyStoreError::Unavailable("keychain locked".into()));
        }
        Ok(())
    }
}

impl KeyStore for MemoryKeyStore {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, KeyStoreError> {
        self.check()?;
        Ok(self.secrets.lock().unwrap().get(name).cloned())
    }

    fn set(&self, name: &str, secret: &[u8]) -> Result<(), KeyStoreError> {
        self.check()?;
        self.secrets
            .lock()
            .unwrap()
            .insert(name.into(), secret.to_vec());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), KeyStoreError> {
        self.check()?;
        self.secrets.lock().unwrap().remove(name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_key_once_and_reuses_it() {
        let store = MemoryKeyStore::default();
        let first = get_or_create(&store, "outbox").unwrap();
        let second = get_or_create(&store, "outbox").unwrap();
        assert_eq!(first, second);
        assert_ne!(first, [0u8; KEY_LEN]);
    }

    #[test]
    fn a_wrong_length_key_is_corrupt() {
        let store = MemoryKeyStore::default();
        store.set("outbox", b"short").unwrap();
        assert!(matches!(
            get_or_create(&store, "outbox"),
            Err(KeyStoreError::Corrupt)
        ));
    }

    #[test]
    fn surfaces_an_unavailable_keychain() {
        let store = MemoryKeyStore::default();
        store.set_unavailable(true);
        assert!(matches!(
            get_or_create(&store, "outbox"),
            Err(KeyStoreError::Unavailable(_))
        ));
    }
}
