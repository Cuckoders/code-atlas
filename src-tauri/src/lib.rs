use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
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
const MAX_BLUEPRINT_PROJECT_SIZE: usize = 4 * 1024 * 1024;
const MAX_BLUEPRINT_PROJECT_FILES: usize = 260;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlueprintProjectFile {
    path: String,
    contents: String,
    overwrite: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedBlueprintProject {
    folder_name: String,
    written: Vec<String>,
    skipped: Vec<String>,
}

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

#[tauri::command]
fn write_blueprint_project(parent_path: String, folder_name: String, files: Vec<BlueprintProjectFile>) -> Result<SavedBlueprintProject, String> {
    let parent = fs::canonicalize(&parent_path).map_err(|error| format!("Failed to open destination: {error}"))?;
    if !parent.is_dir() || !is_safe_segment(&folder_name) {
        return Err("Blueprint destination is invalid".to_string());
    }
    if files.is_empty() || files.len() > MAX_BLUEPRINT_PROJECT_FILES
        || files.iter().map(|file| file.contents.len()).sum::<usize>() > MAX_BLUEPRINT_PROJECT_SIZE {
        return Err("Blueprint project is too large".to_string());
    }
    let root = parent.join(&folder_name);
    fs::create_dir_all(&root).map_err(|error| format!("Failed to create Blueprint folder: {error}"))?;
    let canonical_root = fs::canonicalize(&root).map_err(|error| format!("Failed to inspect Blueprint folder: {error}"))?;
    let mut written = Vec::new();
    let mut skipped = Vec::new();
    for file in files {
        let relative = safe_relative_path(&file.path)?;
        let target = canonical_root.join(&relative);
        let target_parent = target.parent().ok_or_else(|| "Blueprint file path is invalid".to_string())?;
        fs::create_dir_all(target_parent).map_err(|error| format!("Failed to create Blueprint subfolder: {error}"))?;
        let canonical_parent = fs::canonicalize(target_parent).map_err(|error| format!("Failed to inspect Blueprint subfolder: {error}"))?;
        if !canonical_parent.starts_with(&canonical_root) {
            return Err("Blueprint file escaped its destination".to_string());
        }
        if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err("Blueprint file cannot be a symbolic link".to_string());
        }
        let result = if file.overwrite {
            fs::write(&target, file.contents.as_bytes())
        } else {
            OpenOptions::new().write(true).create_new(true).open(&target)
                .and_then(|mut output| output.write_all(file.contents.as_bytes()))
        };
        match result {
            Ok(()) => written.push(file.path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && !file.overwrite => skipped.push(file.path),
            Err(error) => return Err(format!("Failed to save Blueprint project: {error}")),
        }
    }
    Ok(SavedBlueprintProject { folder_name, written, skipped })
}

#[tauri::command]
fn read_blueprint_project(path: String) -> Result<String, String> {
    let directory = fs::canonicalize(&path).map_err(|error| format!("Failed to open Blueprint folder: {error}"))?;
    if !directory.is_dir() {
        return Err("Blueprint path must be a folder".to_string());
    }
    let manifest = directory.join("code-atlas.blueprint.json");
    let metadata = fs::metadata(&manifest)
        .map_err(|_| "В выбранной папке нет code-atlas.blueprint.json".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_BLUEPRINT_FILE_SIZE as u64 {
        return Err("Blueprint manifest is invalid or too large".to_string());
    }
    fs::read_to_string(manifest).map_err(|error| format!("Failed to read Blueprint manifest: {error}"))
}

fn is_safe_segment(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value != "." && value != ".."
        && value.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute() || value.len() > 512 || value.contains('\\') {
        return Err("Blueprint file path is invalid".to_string());
    }
    let components: Vec<_> = path.components().collect();
    if components.is_empty() || components.len() > 8
        || components.iter().any(|component| !matches!(component, Component::Normal(_))) {
        return Err("Blueprint file path is invalid".to_string());
    }
    Ok(path.to_path_buf())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            backend_connection,
            write_blueprint_file,
            read_blueprint_file,
            write_blueprint_project,
            read_blueprint_project,
        ])
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
