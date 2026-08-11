//! Secure credential storage backed by the operating system keyring.

use keyring::Entry;
use serde::Serialize;

const SERVICE: &str = "com.walactv.desktop";

#[derive(Serialize)]
pub struct StoredCredentials {
    pub username: String,
    pub password: String,
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|error| format!("No se pudo abrir el keyring: {error}"))
}

#[tauri::command]
pub fn secure_credentials_save(username: String, password: String) -> Result<(), String> {
    entry("username")?
        .set_password(&username)
        .map_err(|error| format!("No se pudo guardar el usuario: {error}"))?;

    if let Err(error) = entry("password")?.set_password(&password) {
        let _ = entry("username").and_then(|item| {
            item.delete_credential()
                .map_err(|cleanup| format!("{cleanup}"))
        });
        return Err(format!("No se pudo guardar la contraseña: {error}"));
    }

    Ok(())
}

#[tauri::command]
pub fn secure_credentials_load() -> Result<Option<StoredCredentials>, String> {
    let username = match entry("username")?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("No se pudo leer el usuario: {error}")),
    };
    let password = match entry("password")?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("No se pudo leer la contraseña: {error}")),
    };

    Ok(Some(StoredCredentials { username, password }))
}

#[tauri::command]
pub fn secure_credentials_clear() -> Result<(), String> {
    for account in ["username", "password"] {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(format!("No se pudo borrar las credenciales: {error}")),
        }
    }
    Ok(())
}
