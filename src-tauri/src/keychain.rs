//! API keys in the operating system's keychain (service `cerebra`, account `source:<id>`).

#[cfg(test)]
use std::collections::HashMap;

pub trait Keys {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&mut self, id: &str, key: &str) -> Result<(), String>;
    fn delete(&mut self, id: &str) -> Result<(), String>;
}

/// The real keychain.
pub struct Keychain;

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("cerebra", &format!("source:{id}")).map_err(|e| format!("Keychain unavailable: {e}"))
}

impl Keys for Keychain {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match entry(id)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Keychain error: {e}")),
        }
    }
    fn set(&mut self, id: &str, key: &str) -> Result<(), String> {
        entry(id)?
            .set_password(key)
            .map_err(|e| format!("Keychain error: {e}"))
    }
    fn delete(&mut self, id: &str) -> Result<(), String> {
        match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Keychain error: {e}")),
        }
    }
}

/// In memory, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryKeys(pub HashMap<String, String>);

#[cfg(test)]
impl Keys for MemoryKeys {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.0.get(id).cloned())
    }
    fn set(&mut self, id: &str, key: &str) -> Result<(), String> {
        self.0.insert(id.into(), key.into());
        Ok(())
    }
    fn delete(&mut self, id: &str) -> Result<(), String> {
        self.0.remove(id);
        Ok(())
    }
}
