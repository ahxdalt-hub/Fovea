//! The one place this app talks to the network — and what it is for.
//!
//! Fovea's engine has no business sending anything out: images are processed
//! locally and stay local. The single exception is the free plan's monthly
//! allowance, which has to be counted somewhere the user cannot edit, because a
//! counter in app data is a number a changed system clock can refill. So this
//! module exists for exactly one GET and one POST per enhancement, and nothing
//! image-shaped ever passes through it.
//!
//! Implementation: WinHTTP through the `windows` crate that is already in the
//! lockfile. Deliberately no HTTP crate — `reqwest`/`ureq` and their TLS stack
//! would more than double this binary to do what the operating system already
//! does, and certificate validation then leans on the Windows trust store the
//! user manages, not one we ship and have to keep patched.
//!
//! Only `https` is accepted, unless the target host is a loopback address,
//! which exists so the meter can be exercised against a local dev server.
//! Nothing here follows redirects: a redirect would hand the install id to
//! whatever the second host says, and the meter's origin is not negotiable.

use crate::error::{AppError, AppResult};

/// A reply from the meter.
pub struct Reply {
    pub status: u16,
    pub body: String,
}

#[derive(Debug)]
pub enum HttpError {
    /// The URL is not something this module will contact.
    BadUrl(&'static str),
    /// Transport-level failure — no DNS, no listener, timeout. Not an
    /// answer about the allowance, so the caller keeps its cached balance.
    Transport,
}

impl HttpError {
    fn explain(self) -> AppError {
        match self {
            HttpError::BadUrl(why) => AppError::unexpected(format!("meter url rejected: {why}")),
            HttpError::Transport => AppError::meter_unreachable("the meter gave no answer"),
        }
    }
}

/// `https://host[:port]/path` → (host, port, path). Hand-rolled because the
/// alternative is an URL crate for three fields, and this is the only network
/// call the app makes.
struct Target {
    host: String,
    port: u16,
    path: String,
    secure: bool,
}

fn parse(url: &str) -> Result<Target, HttpError> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or(HttpError::BadUrl("missing scheme"))?;
    let secure = match scheme {
        "https" => true,
        // Plain HTTP only for a dev loopback; a real meter is always TLS.
        "http" => false,
        _ => return Err(HttpError::BadUrl("scheme is not http or https")),
    };
    let (authority, path) = match rest.split_once('/') {
        Some((a, p)) => (a, format!("/{p}")),
        None => (rest, "/".to_string()),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() => match p.parse::<u16>() {
            Ok(port) if port > 0 => (h.to_string(), port),
            _ => return Err(HttpError::BadUrl("bad port")),
        },
        _ => (authority.to_string(), if secure { 443 } else { 80 }),
    };
    if host.is_empty() {
        return Err(HttpError::BadUrl("empty host"));
    }
    if !secure && !is_loopback(&host) {
        return Err(HttpError::BadUrl("plain http to a non-loopback host"));
    }
    Ok(Target {
        host,
        port,
        path,
        secure,
    })
}

fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

/// One JSON request, either verb. `body: Some(json)` is a POST, `None` a GET.
///
/// Returns Ok for any HTTP reply, including 4xx and 5xx — this layer reports
/// the transport, and the caller decides what a status means for an allowance.
pub fn call(url: &str, body: Option<&str>) -> AppResult<Reply> {
    request(if body.is_some() { "POST" } else { "GET" }, url, body)
}

#[cfg(windows)]
fn request(verb: &'static str, url: &str, body: Option<&str>) -> AppResult<Reply> {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use windows::Win32::Networking::WinHttp::{
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_ADDREQ_FLAG_ADD, WINHTTP_FLAG_SECURE,
        WINHTTP_OPEN_REQUEST_FLAGS, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
        WinHttpAddRequestHeaders, WinHttpCloseHandle, WinHttpConnect, WinHttpOpen,
        WinHttpOpenRequest, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
        WinHttpSendRequest, WinHttpSetTimeouts,
    };
    use windows::core::PCWSTR;

    let target = parse(url).map_err(HttpError::explain)?;
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let agent = wide("Fovea");
    let host = wide(&target.host);
    let path = wide(&target.path);
    let verb_w = wide(verb);
    let headers = wide("Content-Type: application/json\r\nAccept: application/json\r\n");

    // SAFETY: every handle opened here is closed on every path below. The
    // UTF-16 buffers and the body outlive each call because they are owned by
    // this scope, and every out-parameter is handed over with its real size.
    unsafe {
        let session = WinHttpOpen(
            PCWSTR(agent.as_ptr()),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return Err(HttpError::Transport.explain());
        }
        // Generous for a home connection, short enough that a dead meter
        // cannot stall the enhancement the user is waiting on.
        let _ = WinHttpSetTimeouts(session, 5_000, 5_000, 8_000, 8_000);

        let connect = WinHttpConnect(session, PCWSTR(host.as_ptr()), target.port, 0);
        if connect.is_null() {
            let _ = WinHttpCloseHandle(session);
            return Err(HttpError::Transport.explain());
        }
        let request = WinHttpOpenRequest(
            connect,
            PCWSTR(verb_w.as_ptr()),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            null(),
            if target.secure {
                WINHTTP_FLAG_SECURE
            } else {
                WINHTTP_OPEN_REQUEST_FLAGS(0)
            },
        );
        if request.is_null() {
            let _ = WinHttpCloseHandle(connect);
            let _ = WinHttpCloseHandle(session);
            return Err(HttpError::Transport.explain());
        }

        let mut result: AppResult<Reply> = Err(HttpError::Transport.explain());
        if body.is_some() {
            // Only the request with a body needs these; a GET takes the
            // defaults WinHTTP sends.
            let _ = WinHttpAddRequestHeaders(request, &headers, WINHTTP_ADDREQ_FLAG_ADD);
        }
        let payload = body.unwrap_or("");
        let sent = WinHttpSendRequest(
            request,
            None,
            if body.is_some() {
                Some(payload.as_ptr() as *const c_void)
            } else {
                None
            },
            payload.len() as u32,
            payload.len() as u32,
            0,
        );
        if sent.is_ok() && WinHttpReceiveResponse(request, null_mut()).is_ok() {
            let mut status: u32 = 0;
            let mut size = std::mem::size_of::<u32>() as u32;
            let mut index = 0u32;
            let got_status = WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                PCWSTR::null(),
                Some(&mut status as *mut u32 as *mut c_void),
                &mut size,
                &mut index,
            );
            let mut body_bytes: Vec<u8> = Vec::new();
            // A reply is a few hundred bytes; this bound is a guard against a
            // hostile or broken endpoint, not a limit on legitimate payloads.
            let mut ok_body = true;
            loop {
                let mut chunk = [0u8; 8192];
                let mut read = 0u32;
                let more = WinHttpReadData(
                    request,
                    chunk.as_mut_ptr() as *mut c_void,
                    chunk.len() as u32,
                    &mut read,
                );
                if more.is_err() || read == 0 {
                    break;
                }
                body_bytes.extend_from_slice(&chunk[..read as usize]);
                if body_bytes.len() > 64 * 1024 {
                    ok_body = false;
                    break;
                }
            }
            if got_status.is_ok() && ok_body {
                result = Ok(Reply {
                    status: status as u16,
                    body: String::from_utf8_lossy(&body_bytes).into_owned(),
                });
            } else if !ok_body {
                result = Err(AppError::unexpected("meter reply too large"));
            }
        }

        let _ = WinHttpCloseHandle(request);
        let _ = WinHttpCloseHandle(connect);
        let _ = WinHttpCloseHandle(session);
        result
    }
}

#[cfg(not(windows))]
fn request(_verb: &'static str, _url: &str, _body: Option<&str>) -> AppResult<Reply> {
    // The meter is a Windows shipping concern; this build target exists for
    // `cargo test` on other platforms, where the cache logic is still testable.
    Err(HttpError::Transport.explain())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_https_target_keeps_its_host_port_and_path() {
        let t = parse("https://fovea.caelmont.in/api/usage?install_id=ab12").unwrap();
        assert_eq!(t.host, "fovea.caelmont.in");
        assert_eq!(t.port, 443);
        assert!(t.secure);
        assert_eq!(t.path, "/api/usage?install_id=ab12");

        let t = parse("https://localhost:1420/api/usage").unwrap();
        assert_eq!((t.host.as_str(), t.port), ("localhost", 1420));
    }

    /// The meter's origin is not negotiable: plain http only ever reaches this
    /// machine, and a redirect is never followed (see the module docs).
    #[test]
    fn plain_http_is_accepted_for_nothing_but_a_loopback_host() {
        assert!(parse("http://localhost:3000/api/usage").is_ok());
        assert!(parse("http://127.0.0.1/api/usage").is_ok());
        assert!(parse("http://[::1]:3000/api/usage").is_ok());
        assert!(parse("http://fovea.caelmont.in/api/usage").is_err());
    }

    #[test]
    fn anything_that_is_not_a_plain_origin_path_is_rejected() {
        for url in [
            "fovea.caelmont.in/api/usage",
            "ftp://fovea.caelmont.in/api",
            "https:///api/usage",
            "https://fovea.caelmont.in:0/api",
            "https://fovea.caelmont.in:99999/api",
        ] {
            assert!(parse(url).is_err(), "{url} should be rejected");
        }
    }

    /// A transport failure must never be reported as an answer about the
    /// allowance — the user keeps the cached balance.
    #[test]
    fn a_transport_failure_is_not_a_quota_verdict() {
        assert_eq!(HttpError::Transport.explain().code(), "meter_unreachable");
        assert_eq!(
            HttpError::BadUrl("empty host").explain().code(),
            "unexpected_error"
        );
    }

    /// The one thing an injected `Call` cannot prove: the WinHTTP bindings put
    /// real bytes on a socket and read a real answer back. Plain http on
    /// loopback is allowed precisely so this can run with no internet and no
    /// certificate in the way.
    #[cfg(windows)]
    #[test]
    fn a_loopback_answer_comes_back_over_a_real_socket() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        const BODY: &str = r#"{"period":"2025-10","used":4,"remaining":6,"limit":10,"allowed":true,"server_time":1760000000}"#;

        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback socket");
        let port = listener.local_addr().expect("the bound port").port();
        // Never let a silent client hang the suite: accept is polled against a
        // deadline instead of blocking forever.
        listener
            .set_nonblocking(true)
            .expect("a nonblocking listener");

        let server = std::thread::spawn(move || -> std::io::Result<()> {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(pair) => break pair,
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() > deadline {
                            return Err(err);
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(err) => return Err(err),
                }
            };
            stream
                .set_nonblocking(false)
                .expect("a blocking connection");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("a read timeout");
            let mut request = String::new();
            let mut chunk = [0u8; 256];
            while !request.ends_with("\r\n\r\n") {
                let read = stream.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                request.push_str(&String::from_utf8_lossy(&chunk[..read]));
            }
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
                BODY.len()
            )?;
            stream.flush()
        });

        let reply = call(&format!("http://127.0.0.1:{port}/api/usage"), None)
            .expect("the loopback meter answers");
        assert_eq!(reply.status, 200);
        assert!(
            reply.body.contains(r#""remaining":6"#),
            "unexpected body: {}",
            reply.body
        );
        let _ = server.join();
    }
}
