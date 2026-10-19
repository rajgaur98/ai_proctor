//! Where the outbox encryption key lives. Production uses the OS keychain
//! (`agent-platform`); tests use `MemoryKeyStore`.

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
    /// The key under `name`, or `None` if it was never created.
    fn get(&self, name: &str) -> Result<Option<Key>, KeyStoreError>;
    fn set(&self, name: &str, key: &Key) -> Result<(), KeyStoreError>;
}

/// Returns the key under `name`, creating and storing a random one on first run.
pub fn get_or_create(store: &dyn KeyStore, name: &str) -> Result<Key, KeyStoreError> {
    if let Some(key) = store.get(name)? {
        return Ok(key);
    }
    let mut key = [0u8; KEY_LEN];
    getrandom::fill(&mut key).map_err(|e| KeyStoreError::Unavailable(e.to_string()))?;
    store.set(name, &key)?;
    Ok(key)
}

/// In-memory store for tests; can be switched to fail like a locked keychain.
#[derive(Default)]
pub struct MemoryKeyStore {
    keys: Mutex<std::collections::HashMap<String, Key>>,
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
    fn get(&self, name: &str) -> Result<Option<Key>, KeyStoreError> {
        self.check()?;
        Ok(self.keys.lock().unwrap().get(name).copied())
    }

    fn set(&self, name: &str, key: &Key) -> Result<(), KeyStoreError> {
        self.check()?;
        self.keys.lock().unwrap().insert(name.into(), *key);
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
    fn surfaces_an_unavailable_keychain() {
        let store = MemoryKeyStore::default();
        store.set_unavailable(true);
        assert!(matches!(
            get_or_create(&store, "outbox"),
            Err(KeyStoreError::Unavailable(_))
        ));
    }
}
