use std::{fs, path::Path, sync::Mutex};

use serde::Serialize;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::CommandEvent;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendConnection {
    origin: String,
    token: Option<String>,
}

struct BackendState {
    connection: BackendConnection,
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn backend_connection(state: tauri::State<'_, BackendState>) -> BackendConnection {
    state.connection.clone()
}

const MAX_BLUEPRINT_FILE_SIZE: usize = 300 * 1024;

#[tauri::command]
fn write_blueprint_file(path: String, contents: String) -> Result<(), String> {
    validate_blueprint_file_path(&path)?;
    if contents.len() > MAX_BLUEPRINT_FILE_SIZE {
        return Err("Blueprint file is too large".to_string());
    }
    fs::write(path, contents).map_err(|error| format!("Failed to save Blueprint: {error}"))
}

#[tauri::command]
fn read_blueprint_file(path: String) -> Result<String, String> {
    validate_blueprint_file_path(&path)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("Failed to inspect Blueprint: {error}"))?;
    if metadata.len() > MAX_BLUEPRINT_FILE_SIZE as u64 {
        return Err("Blueprint file is too large".to_string());
    }
    fs::read_to_string(path).map_err(|error| format!("Failed to open Blueprint: {error}"))
}

fn validate_blueprint_file_path(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    let is_json = path.extension().and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));
    if !path.is_absolute() || !is_json {
        return Err("Blueprint path must be an absolute JSON file path".to_string());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![backend_connection, write_blueprint_file, read_blueprint_file])
        .setup(setup_backend)
        .build(tauri::generate_context!())
        .expect("error while building Code Atlas");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            let state = app_handle.state::<BackendState>();
            let child = state.child.lock().ok().and_then(|mut guard| guard.take());
            if let Some(child) = child {
                let _ = child.kill();
            }
        }
    });
}

fn setup_backend(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    {
        app.manage(BackendState {
            connection: BackendConnection {
                origin: "http://127.0.0.1:4310".to_string(),
                token: None,
            },
            child: Mutex::new(None),
        });
    }

    #[cfg(not(debug_assertions))]
    setup_release_backend(app)?;

    Ok(())
}

#[cfg(not(debug_assertions))]
fn setup_release_backend(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::net::TcpListener;

    use tauri::path::BaseDirectory;
    use tauri_plugin_shell::ShellExt;
    use uuid::Uuid;

    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);

    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let server_path = app
        .path()
        .resolve("backend/server.mjs", BaseDirectory::Resource)?;
    let worker_path = app
        .path()
        .resolve("backend/analysis-worker.mjs", BaseDirectory::Resource)?;
    let wasm_directory = app
        .path()
        .resolve("backend/wasm", BaseDirectory::Resource)?;
    let demo_path = app
        .path()
        .resolve("backend/demo", BaseDirectory::Resource)?;
    let data_directory = app.path().app_data_dir()?;
    fs::create_dir_all(&data_directory)?;
    let database_path = data_directory.join("code-atlas.sqlite");

    for required_path in [&server_path, &worker_path, &wasm_directory, &demo_path] {
        if !required_path.exists() {
            return Err(format!(
                "missing bundled backend resource: {}",
                required_path.display()
            )
            .into());
        }
    }

    let (mut receiver, child) = app
        .shell()
        .sidecar("code-atlas-node")?
        .arg(&server_path)
        .current_dir(&data_directory)
        .env("NODE_ENV", "production")
        .env("NODE_OPTIONS", "")
        .env("NODE_PATH", "")
        .env("PORT", port.to_string())
        .env("CODE_ATLAS_DESKTOP_SIDECAR", "1")
        .env("CODE_ATLAS_API_TOKEN", &token)
        .env("CODE_ATLAS_DATABASE", &database_path)
        .env("CODE_ATLAS_WORKER_PATH", &worker_path)
        .env("CODE_ATLAS_WASM_DIR", &wasm_directory)
        .env("CODE_ATLAS_DEMO_PATH", &demo_path)
        .spawn()?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    eprintln!("[code-atlas-backend] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!(
                        "[code-atlas-backend:error] {}",
                        String::from_utf8_lossy(&bytes)
                    );
                }
                CommandEvent::Error(error) => eprintln!("[code-atlas-backend:error] {error}"),
                CommandEvent::Terminated(status) => {
                    eprintln!("[code-atlas-backend] exited with {:?}", status.code);
                }
                _ => {}
            }
        }
    });

    app.manage(BackendState {
        connection: BackendConnection {
            origin: format!("http://127.0.0.1:{port}"),
            token: Some(token),
        },
        child: Mutex::new(Some(child)),
    });

    Ok(())
}
