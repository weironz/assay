# Assay transport patch

Upstream: `smb-transport` 0.12.1, https://github.com/afiffon/smb-rs,
commit `7c7d4a60c930e3780e95208967aa13b6346eaa25`, `crates/smb-transport`.
The packaged Cargo manifest and source are retained, with the upstream MIT license.

The local transport change enables `TCP_NODELAY` before splitting the connected
socket. Upstream sends the four-byte framing header separately from the message;
Nagle and delayed ACK otherwise add roughly 40 ms to small metadata requests.
This makes large ACL scans impractically slow even over loopback. SMB encryption,
signing, authentication, framing and access checks are unchanged.

A loopback regression test checks the actual connected socket option. The test
manifest enables Tokio's test runtime. Remove this patch when an upstream version
provides equivalent transport behavior and passes the SMB acceptance checks.
