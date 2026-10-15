#[path = "../portal/mod.rs"]
mod portal;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    portal::run().await
}
