//! OS keychain (macOS Keychain, Windows Credential Manager) behind
//! `agent_core::keystore::KeyStore`. On other OSes keyring's in-memory mock is
//! used, which is enough for CI to compile and test.

use agent_core::keystore::{KeyStore, KeyStoreError};

pub const SERVICE: &str = "com.aiproctor.agent";

#[derive(Default)]
pub struct OsKeychain;

impl OsKeychain {
    fn entry(name: &str) -> Result<keyring::Entry, KeyStoreError> {
        keyring::Entry::new(SERVICE, name).map_err(|e| KeyStoreError::Unavailable(e.to_string()))
    }
}

impl KeyStore for OsKeychain {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, KeyStoreError> {
        match Self::entry(name)?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(KeyStoreError::Unavailable(e.to_string())),
        }
    }

    fn set(&self, name: &str, secret: &[u8]) -> Result<(), KeyStoreError> {
        Self::entry(name)?
            .set_secret(secret)
            .map_err(|e| KeyStoreError::Unavailable(e.to_string()))
    }

    fn delete(&self, name: &str) -> Result<(), KeyStoreError> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(KeyStoreError::Unavailable(e.to_string())),
        }
    }
}
