mod setup;

use greenways_desktop_bridge::{
    decode_request, encode_response, now_unix_ms, DaemonDesktopBackend, DesktopBridgeError,
    DesktopBridgeHost, DesktopBridgeResponse, MAX_DESKTOP_REQUEST_BYTES,
};
use setup::{
    decode_setup_request, encode_setup_response, request_protocol, DesktopSetupHost,
    DesktopSetupResponse, SystemDesktopSetupBackend, DESKTOP_SETUP_PROTOCOL,
};
use std::io::{self, BufRead, Write};

fn main() {
    if run().is_err() {
        eprintln!("Greenways Desktop bridge stopped unexpectedly.");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os().len() != 1 {
        return Err("greenways-desktop-bridge accepts no external setup inputs".into());
    }
    let backend = DaemonDesktopBackend::resolve()?;
    let setup_inspector = SystemDesktopSetupBackend::resolve()?;
    let observed_at_unix_ms = now_unix_ms()?;
    let mut connection_host = DesktopBridgeHost::new(backend, observed_at_unix_ms);
    let mut setup_host = DesktopSetupHost::new(setup_inspector, observed_at_unix_ms);
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut stdout = io::stdout().lock();

    while let Some(line) = read_bounded_line(&mut input)? {
        let observed_at = now_unix_ms()?;
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                let response = DesktopBridgeResponse::invalid(error, observed_at);
                stdout.write_all(&encode_response(&response)?)?;
                stdout.flush()?;
                continue;
            }
        };

        if request_protocol(&line).as_deref() == Some(DESKTOP_SETUP_PROTOCOL) {
            let response = match decode_setup_request(&line) {
                Ok(request) => setup_host
                    .handle(request)
                    .unwrap_or_else(|error| DesktopSetupResponse::invalid(error, observed_at)),
                Err(error) => DesktopSetupResponse::invalid(error, observed_at),
            };
            stdout.write_all(&encode_setup_response(&response)?)?;
            stdout.flush()?;
            continue;
        }

        let decoded = decode_request(&line);
        let (response, quit) = match decoded {
            Ok(request) => match connection_host.handle(request) {
                Ok(result) => result,
                Err(error) => (DesktopBridgeResponse::invalid(error, observed_at), false),
            },
            Err(error) => (DesktopBridgeResponse::invalid(error, observed_at), false),
        };
        stdout.write_all(&encode_response(&response)?)?;
        stdout.flush()?;
        if quit {
            break;
        }
    }
    Ok(())
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
) -> io::Result<Option<Result<Vec<u8>, DesktopBridgeError>>> {
    let mut line = Vec::new();
    let mut too_large = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.is_empty() && !too_large {
                return Ok(None);
            }
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !too_large {
            if line.len().saturating_add(consumed) > MAX_DESKTOP_REQUEST_BYTES + 1 {
                too_large = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..consumed]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            break;
        }
    }

    if too_large {
        return Ok(Some(Err(DesktopBridgeError::ProtocolMismatch(
            "Desktop bridge requests are limited to 64 KiB.".to_owned(),
        ))));
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Some(Ok(line)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_multiple_bounded_requests_without_crossing_frames() {
        let mut input = Cursor::new(b"first\nsecond\r\n".to_vec());
        assert_eq!(
            read_bounded_line(&mut input).unwrap().unwrap().unwrap(),
            b"first"
        );
        assert_eq!(
            read_bounded_line(&mut input).unwrap().unwrap().unwrap(),
            b"second"
        );
        assert!(read_bounded_line(&mut input).unwrap().is_none());
    }

    #[test]
    fn discards_an_oversized_frame_before_reading_the_next_one() {
        let mut bytes = vec![b'x'; MAX_DESKTOP_REQUEST_BYTES + 1];
        bytes.extend_from_slice(b"\nnext\n");
        let mut input = Cursor::new(bytes);
        assert!(read_bounded_line(&mut input).unwrap().unwrap().is_err());
        assert_eq!(
            read_bounded_line(&mut input).unwrap().unwrap().unwrap(),
            b"next"
        );
    }
}
