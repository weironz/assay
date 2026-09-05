mod api;
mod config;
mod mcp;
mod update;

use anyhow::{Context, Result, bail};
use api::ApiClient;
use clap::{Args, Parser, Subcommand, ValueEnum};
use config::{Config, ConfigStore};
use serde_json::{Value, json};
use std::io::{IsTerminal, Read};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_BASE_URL: &str = "https://assay.cloudcele.com/api";

#[derive(Parser, Debug)]
#[command(name = "assay", version, about = "Assay 工单系统命令行与 MCP 客户端")]
#[command(after_help = "非交互环境默认输出 JSON。详情：assay <command> --help")]
struct Cli {
    /// Assay API 地址；也可使用 ASSAY_BASE_URL
    #[arg(long, global = true, env = "ASSAY_BASE_URL")]
    base_url: Option<String>,

    /// 输出格式。JSON 适用于脚本和 AI；pretty 便于人工阅读
    #[arg(long, global = true, value_enum, default_value_t = OutputFormat::Auto)]
    output: OutputFormat,

    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum OutputFormat {
    Auto,
    Json,
    Pretty,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// 登录、登出和查看当前会话
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    /// 配置 API 地址
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// 查询和回复工单
    Ticket {
        #[command(subcommand)]
        command: TicketCommand,
    },
    /// 启动供 Codex、Claude Desktop 等调用的本地 stdio MCP Server
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
    /// 检查或安装 assay-cli 的新版本
    Update(UpdateArgs),
}

#[derive(Subcommand, Debug)]
enum AuthCommand {
    /// 以邮箱和密码登录；密码不会写入磁盘
    Login(LoginArgs),
    /// 清除本机保存的会话
    Logout,
    /// 查看当前登录用户
    Whoami,
}

#[derive(Args, Debug)]
struct LoginArgs {
    /// 登录邮箱
    #[arg(long)]
    email: String,
    /// 从标准输入读取密码（适用于 CI；避免把密码放入命令历史）
    #[arg(long)]
    password_stdin: bool,
}

#[derive(Subcommand, Debug)]
enum ConfigCommand {
    /// 写入默认 API 地址
    SetUrl { url: String },
    /// 显示当前配置（不会显示会话 Cookie）
    Show,
}

#[derive(Subcommand, Debug)]
enum TicketCommand {
    /// 列出或搜索工单
    List(TicketListArgs),
    /// 读取一张工单的完整详情、讨论和参与人
    Get { id: String },
    /// 在工单讨论中发表评论
    Comment(TicketCommentArgs),
}

#[derive(Args, Debug, Default)]
struct TicketListArgs {
    #[arg(long)]
    status: Option<String>,
    #[arg(long)]
    priority: Option<String>,
    #[arg(long)]
    keyword: Option<String>,
    #[arg(long)]
    assignee_id: Option<String>,
    #[arg(long, default_value_t = 1)]
    page: u32,
    #[arg(long, default_value_t = 20)]
    page_size: u32,
}

#[derive(Args, Debug)]
struct TicketCommentArgs {
    /// 工单 ID 或工单号
    id: String,
    /// 评论正文；传 - 时从标准输入读取
    #[arg(long)]
    body: String,
    /// 标记为内部备注（提单人及关注人不可见）
    #[arg(long)]
    internal: bool,
    /// 提及的用户 ID，可重复指定
    #[arg(long = "mention-user-id")]
    mention_user_ids: Vec<String>,
}

#[derive(Subcommand, Debug)]
enum McpCommand {
    Serve,
}

#[derive(Args, Debug)]
struct UpdateArgs {
    /// 仅检查，不下载或替换可执行文件
    #[arg(long)]
    check: bool,
}

fn main() {
    let cli = Cli::parse();
    let result = run(cli);
    if let Err(error) = result {
        eprintln!(
            "{}",
            json!({ "error": error.to_string(), "status": "error" })
        );
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    let mut store = ConfigStore::load()?;
    if let Some(base_url) = cli.base_url.as_ref() {
        store.config.base_url = normalize_base_url(base_url)?;
    }

    match cli.command {
        Command::Mcp {
            command: McpCommand::Serve,
        } => return mcp::serve(store.config),
        Command::Update(args) => return update::run(args.check),
        _ => {}
    }

    let value = match cli.command {
        Command::Config {
            command: ConfigCommand::SetUrl { url },
        } => {
            store.config.base_url = normalize_base_url(&url)?;
            store.save()?;
            json!({ "baseUrl": store.config.base_url, "saved": true })
        }
        Command::Config {
            command: ConfigCommand::Show,
        } => json!({
            "baseUrl": store.config.base_url,
            "hasSession": store.config.session_cookie.is_some() || std::env::var("ASSAY_SESSION_COOKIE").is_ok(),
            "configPath": store.path,
        }),
        Command::Auth {
            command: AuthCommand::Login(args),
        } => {
            let password = read_password(args.password_stdin)?;
            let cookie = ApiClient::login(&store.config.base_url, &args.email, &password)?;
            store.config.session_cookie = Some(cookie);
            store.save()?;
            let client = ApiClient::from_config(&store.config)?;
            json!({ "loggedIn": true, "user": client.get("/me")? })
        }
        Command::Auth {
            command: AuthCommand::Logout,
        } => {
            if let Ok(client) = ApiClient::from_config(&store.config) {
                let _ = client.post("/auth/sign-out", json!({}));
            }
            store.config.session_cookie = None;
            store.save()?;
            json!({ "loggedOut": true })
        }
        Command::Auth {
            command: AuthCommand::Whoami,
        } => ApiClient::from_config(&store.config)?.get("/me")?,
        Command::Ticket {
            command: TicketCommand::List(args),
        } => {
            let mut query = vec![
                ("page", args.page.to_string()),
                ("pageSize", args.page_size.to_string()),
            ];
            for (key, value) in [
                ("status", args.status),
                ("priority", args.priority),
                ("keyword", args.keyword),
                ("assigneeId", args.assignee_id),
            ] {
                if let Some(value) = value {
                    query.push((key, value));
                }
            }
            ApiClient::from_config(&store.config)?.get_with_query("/tickets", &query)?
        }
        Command::Ticket {
            command: TicketCommand::Get { id },
        } => ApiClient::from_config(&store.config)?.get_ticket(&id)?,
        Command::Ticket {
            command: TicketCommand::Comment(args),
        } => {
            let body = if args.body == "-" {
                read_stdin()?
            } else {
                args.body
            };
            if body.trim().is_empty() {
                bail!("评论内容不能为空");
            }
            ApiClient::from_config(&store.config)?.post(
                &format!("/tickets/{}/messages", args.id),
                json!({
                    "body": body,
                    "isInternal": args.internal,
                    "mentionUserIds": args.mention_user_ids,
                }),
            )?
        }
        Command::Mcp { .. } | Command::Update(_) => unreachable!(),
    };
    print_value(&value, cli.output);
    Ok(())
}

fn normalize_base_url(value: &str) -> Result<String> {
    let value = value.trim().trim_end_matches('/');
    if !value.starts_with("https://") && !value.starts_with("http://") {
        bail!("API 地址必须以 http:// 或 https:// 开头");
    }
    Ok(if value.ends_with("/api") {
        value.to_owned()
    } else {
        format!("{value}/api")
    })
}

fn read_password(from_stdin: bool) -> Result<String> {
    if from_stdin {
        let value = read_stdin()?;
        if value.is_empty() {
            bail!("没有从标准输入读取到密码");
        }
        return Ok(value);
    }
    if !std::io::stdin().is_terminal() {
        bail!("非交互环境请使用 --password-stdin，避免把密码写入命令参数");
    }
    rpassword::prompt_password("密码: ").context("读取密码失败")
}

fn read_stdin() -> Result<String> {
    let mut value = String::new();
    std::io::stdin().read_to_string(&mut value)?;
    Ok(value.trim_end_matches(['\r', '\n']).to_owned())
}

fn print_value(value: &Value, output: OutputFormat) {
    let pretty = matches!(output, OutputFormat::Pretty)
        || matches!(output, OutputFormat::Auto) && std::io::stdout().is_terminal();
    if pretty {
        println!(
            "{}",
            serde_json::to_string_pretty(value).expect("JSON serializable")
        );
    } else {
        println!(
            "{}",
            serde_json::to_string(value).expect("JSON serializable")
        );
    }
}

pub fn default_config() -> Config {
    Config {
        base_url: DEFAULT_BASE_URL.to_owned(),
        session_cookie: None,
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_base_url;

    #[test]
    fn normalizes_origin_and_api_path() {
        assert_eq!(
            normalize_base_url("https://assay.example.com/").unwrap(),
            "https://assay.example.com/api"
        );
        assert_eq!(
            normalize_base_url("http://localhost:3000/api/").unwrap(),
            "http://localhost:3000/api"
        );
    }

    #[test]
    fn rejects_a_url_without_scheme() {
        assert!(normalize_base_url("assay.example.com").is_err());
    }
}
