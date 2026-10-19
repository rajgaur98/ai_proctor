//! OS keychain (macOS Keychain, Windows Credential Manager) behind
//! `agent_core::keystore::KeyStore`. On other OSes keyring's in-memory mock is
//! used, which is enough for CI to compile and test.

use agent_core::keystore::{Key, KeyStore, KeyStoreError, KEY_LEN};

pub const SERVICE: &str = "com.aiproctor.agent";

#[derive(Default)]
pub struct OsKeychain;

impl OsKeychain {
    fn entry(name: &str) -> Result<keyring::Entry, KeyStoreError> {
        keyring::Entry::new(SERVICE, name).map_err(|e| KeyStoreError::Unavailable(e.to_string()))
    }
}

impl KeyStore for OsKeychain {
    fn get(&self, name: &str) -> Result<Option<Key>, KeyStoreError> {
        match Self::entry(name)?.get_secret() {
            Ok(secret) => secret
                .try_into()
                .map(Some)
                .map_err(|_| KeyStoreError::Corrupt),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(KeyStoreError::Unavailable(e.to_string())),
        }
    }

    fn set(&self, name: &str, key: &Key) -> Result<(), KeyStoreError> {
        debug_assert_eq!(key.len(), KEY_LEN);
        Self::entry(name)?
            .set_secret(key)
            .map_err(|e| KeyStoreError::Unavailable(e.to_string()))
    }
}
