use super::*;
use futures_util::{StreamExt, stream};
use smb::{
    Directory, File, FileAttributes, FileBasicInformation, FileDirectoryInformation,
    FileDispositionInformation, FileRenameInformation, FileStandardInformation,
    create::CreateOptions,
};

struct FileGuard {
    file: Arc<File>,
    delete: bool,
}
impl Drop for FileGuard {
    fn drop(&mut self) {
        let file = self.file.clone();
        let delete = self.delete;
        tokio::spawn(async move {
            if delete {
                let _ = file
                    .handle()
                    .set_info(FileDispositionInformation::default())
                    .await;
            }
            let _ = file.handle().close().await;
        });
    }
}
async fn regular(
    s: &Session,
    target: &UncPath,
    access: FileAccessMask,
) -> Result<FileGuard, Error> {
    let r = s
        .open(target, access.with_file_read_attributes(true))
        .await?;
    let info = r
        .handle()
        .query_info::<FileBasicInformation>()
        .await
        .map_err(Error::smb)?;
    if info.file_attributes.reparse_point() {
        return Err(Error(StatusCode::FORBIDDEN, "不支持符号链接文件"));
    }
    match r {
        Resource::File(file) => Ok(FileGuard {
            file: Arc::new(file),
            delete: false,
        }),
        _ => Err(Error::invalid()),
    }
}
pub async fn list(
    State(app): State<Arc<App>>,
    h: HeaderMap,
    Query(loc): Query<Location>,
) -> Result<Json<Value>, Error> {
    let (s, _guard) = session(&app, &h).await?;
    let target = s.checked(&app, &loc.share, &loc.path).await?;
    let r = s
        .open(&target, FileAccessMask::new().with_generic_read(true))
        .await?;
    let Resource::Directory(dir) = r else {
        return Err(Error::invalid());
    };
    let dir = Arc::new(dir);
    let mut entries = Directory::query::<FileDirectoryInformation>(&dir, "*")
        .await
        .map_err(Error::smb)?;
    let mut result = vec![];
    while let Some(entry) = entries.next().await {
        s.live()?;
        let e = entry.map_err(Error::smb)?;
        let name = e.file_name.to_string();
        if name == "." || name == ".." || name.to_ascii_lowercase().starts_with(".assay-upload-") {
            continue;
        }
        if result.len() >= 10000 {
            return Err(Error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "目录超过 10000 项，请使用 SMB 客户端访问",
            ));
        }
        let modified = SystemTime::from(e.last_write_time)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        result.push(json!({"name":name,"directory":e.file_attributes.directory(),"blocked":e.file_attributes.reparse_point() || paths::validate(&name,false).is_err(),"size":e.end_of_file,"modified":modified}));
    }
    drop(entries);
    let _ = dir.handle().close().await;
    Ok(Json(json!({"entries":result})))
}
pub async fn download(
    State(app): State<Arc<App>>,
    h: HeaderMap,
    Query(loc): Query<Location>,
) -> Result<Response, Error> {
    paths::validate(&loc.path, false)?;
    let (s, guard) = session(&app, &h).await?;
    let target = s.checked(&app, &loc.share, &loc.path).await?;
    let file = regular(&s, &target, FileAccessMask::new().with_generic_read(true)).await?;
    let size = file
        .file
        .handle()
        .query_info::<FileStandardInformation>()
        .await
        .map_err(Error::smb)?
        .end_of_file;
    let stream = stream::try_unfold(
        (file, s, guard, 0u64),
        move |(file, s, guard, pos)| async move {
            s.live()
                .map_err(|_| std::io::Error::other("file session expired"))?;
            if pos >= size {
                return Ok::<_, std::io::Error>(None);
            }
            let mut buf = vec![0u8; (size - pos).min(65536) as usize];
            let n = file.file.read_block(&mut buf, pos, None, false).await?;
            if n == 0 {
                return Err(std::io::Error::other("file changed during download"));
            }
            buf.truncate(n);
            Ok(Some((
                axum::body::Bytes::from(buf),
                (file, s, guard, pos + n as u64),
            )))
        },
    );
    let name = loc.path.rsplit('/').next().unwrap();
    Response::builder()
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", paths::attachment(name))
        .header("Content-Length", size)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from_stream(stream))
        .map_err(|_| Error::invalid())
}
pub async fn upload(
    State(app): State<Arc<App>>,
    h: HeaderMap,
    Query(loc): Query<Location>,
    body: Body,
) -> Result<Json<Value>, Error> {
    paths::validate(&loc.path, false)?;
    if header(&h, "content-type")?.split(';').next() != Some("application/octet-stream") {
        return Err(Error::invalid());
    }
    let length = header(&h, "content-length")?
        .parse::<u64>()
        .map_err(|_| Error::invalid())?;
    if length > app.config.max_file_bytes {
        return Err(Error(StatusCode::PAYLOAD_TOO_LARGE, "文件超过上传大小限制"));
    }
    let (s, _guard) = session(&app, &h).await?;
    s.checked(&app, &loc.share, paths::parent(&loc.path))
        .await?;
    let parent = paths::parent(&loc.path);
    let temporary = format!(
        "{}{}.assay-upload-{}",
        parent,
        if parent.is_empty() { "" } else { "/" },
        uuid::Uuid::new_v4().simple()
    );
    // Internal temporary name is generated here; never accepted from a client.
    let root = UncPath::from_str(&format!("\\\\{}\\{}", app.config.smb_server, loc.share))
        .map_err(|_| Error::invalid())?;
    let target = root.with_path(&temporary.replace('/', "\\"));
    let mut args = FileCreateArgs::make_create_new(
        FileAttributes::new().with_normal(true),
        CreateOptions::new()
            .with_non_directory_file(true)
            .with_open_reparse_point(true),
    );
    args.desired_access = FileAccessMask::new()
        .with_file_write_data(true)
        .with_file_read_attributes(true)
        .with_delete(true);
    let r = s
        .client
        .create_file(&target, &args)
        .await
        .map_err(Error::smb)?;
    let Resource::File(file) = r else {
        return Err(Error::invalid());
    };
    let mut file = FileGuard {
        file: Arc::new(file),
        delete: true,
    };
    let mut stream = body.into_data_stream();
    let mut bytes = 0u64;
    while let Some(chunk) = stream.next().await {
        s.live()?;
        let chunk = chunk.map_err(|_| Error(StatusCode::BAD_REQUEST, "上传已中断"))?;
        if bytes + chunk.len() as u64 > length {
            return Err(Error(StatusCode::PAYLOAD_TOO_LARGE, "上传大小不匹配"));
        }
        for piece in chunk.chunks(65536) {
            let mut offset = 0;
            while offset < piece.len() {
                let n = file
                    .file
                    .write_block(&piece[offset..], bytes, None)
                    .await
                    .map_err(Error::smb)?;
                if n == 0 {
                    return Err(Error::expired());
                }
                offset += n;
                bytes += n as u64;
            }
        }
    }
    if bytes != length {
        return Err(Error(StatusCode::BAD_REQUEST, "上传不完整"));
    }
    s.live()?;
    file.file.flush().await.map_err(Error::smb)?;
    file.file
        .handle()
        .set_info(FileRenameInformation {
            replace_if_exists: false.into(),
            root_directory: 0,
            file_name: loc.path.replace('/', "\\").into(),
        })
        .await
        .map_err(Error::smb)?;
    file.delete = false;
    file.file.handle().close().await.map_err(Error::smb)?;
    Ok(Json(json!({"ok":true,"bytes":bytes})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    action: String,
    share: String,
    path: String,
    #[serde(default)]
    destination: String,
}
pub async fn command(
    State(app): State<Arc<App>>,
    h: HeaderMap,
    Json(c): Json<Command>,
) -> Result<Json<Value>, Error> {
    paths::validate(&c.path, false)?;
    let (s, _guard) = session(&app, &h).await?;
    match c.action.as_str() {
        "mkdir" => {
            s.checked(&app, &c.share, paths::parent(&c.path)).await?;
            let target = s.target(&app, &c.share, &c.path)?;
            let mut args = FileCreateArgs::make_create_new(
                FileAttributes::new().with_directory(true),
                CreateOptions::new()
                    .with_directory_file(true)
                    .with_open_reparse_point(true),
            );
            args.desired_access = FileAccessMask::new().with_file_read_attributes(true);
            let r = s
                .client
                .create_file(&target, &args)
                .await
                .map_err(Error::smb)?;
            r.handle().close().await.map_err(Error::smb)?;
        }
        "move" | "delete" => {
            let target = s.checked(&app, &c.share, &c.path).await?;
            if c.action == "move" {
                paths::validate(&c.destination, false)?;
                s.checked(&app, &c.share, paths::parent(&c.destination))
                    .await?;
            }
            let r = s
                .open(
                    &target,
                    FileAccessMask::new()
                        .with_delete(true)
                        .with_file_read_attributes(true),
                )
                .await?;
            let basic = r
                .handle()
                .query_info::<FileBasicInformation>()
                .await
                .map_err(Error::smb)?;
            if basic.file_attributes.reparse_point() {
                return Err(Error(StatusCode::FORBIDDEN, "不支持符号链接"));
            }
            let result = if c.action == "move" {
                r.handle()
                    .set_info(FileRenameInformation {
                        replace_if_exists: false.into(),
                        root_directory: 0,
                        file_name: c.destination.replace('/', "\\").into(),
                    })
                    .await
            } else {
                r.handle()
                    .set_info(FileDispositionInformation::default())
                    .await
            };
            let _ = r.handle().close().await;
            result.map_err(Error::smb)?;
        }
        _ => return Err(Error::invalid()),
    }
    Ok(Json(json!({"ok":true})))
}
