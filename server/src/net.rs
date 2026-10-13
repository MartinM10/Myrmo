//! Which address a request comes from, when a reverse proxy may stand in front of the gateway.

use std::net::IpAddr;

/// Loopback and private networks: where a reverse proxy, the hosted MCP server and the containers of one machine
/// live. The default for `MYRMO_TRUSTED_PROXIES`.
pub const PRIVATE_NETWORKS: &str =
    "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7";

/// An address range such as `10.0.0.0/8` or `fc00::/7`. A bare address is a range of one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cidr {
    network: IpAddr,
    prefix: u8,
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.network, self.prefix)
    }
}

impl Cidr {
    pub fn parse(text: &str) -> Option<Self> {
        let (addr, prefix) = match text.trim().split_once('/') {
            Some((a, p)) => (a.parse::<IpAddr>().ok()?, Some(p.parse::<u8>().ok()?)),
            None => (text.trim().parse::<IpAddr>().ok()?, None),
        };
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(max);
        (prefix <= max).then_some(Self {
            network: addr,
            prefix,
        })
    }

    /// Comma-separated ranges; the ones that do not parse are logged and skipped.
    pub fn parse_list(text: &str) -> Vec<Self> {
        text.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .filter_map(|s| {
                let cidr = Self::parse(s);
                if cidr.is_none() {
                    tracing::warn!(range = s, "ignoring an address range that does not parse");
                }
                cidr
            })
            .collect()
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        // An IPv4 peer can reach a dual-stack socket as ::ffff:a.b.c.d.
        let ip = match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
            v4 => v4,
        };
        match (self.network, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

/// Whether a connection from `peer` may be served when only `allowed` networks may connect. An empty list allows
/// everyone. Loopback is always allowed: the machine itself (health checks, its own operator commands) is not a client
/// to keep out. It looks at the peer of the connection and never at `X-Forwarded-For`, which any host of a private
/// network could write; behind a reverse proxy the proxy has to do the filtering, or its network has to be listed.
pub fn allows(peer: IpAddr, allowed: &[Cidr]) -> bool {
    let loopback = match peer {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(peer, IpAddr::V4),
        v4 => v4,
    }
    .is_loopback();
    allowed.is_empty() || loopback || allowed.iter().any(|c| c.contains(peer))
}

/// What a refused connection is told: the address the colony sees it as (a router that translates addresses shows up
/// here as the address to allow) and, when that is Docker's own network, the usual cause: the caller reached the
/// published port from the colony's own machine through `localhost`.
pub fn refusal(peer: IpAddr) -> String {
    let own_network = match peer {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 172 && (16..=31).contains(&o[1])
        }
        IpAddr::V6(_) => false,
    };
    let hint = if own_network {
        " If you are on the colony's own machine, use its network address in the URL, not localhost."
    } else {
        ""
    };
    format!("This colony is not open to your network: it sees you as {peer}.{hint}")
}

/// The address quotas are counted against: the first `X-Forwarded-For` entry when the peer is a trusted proxy (the
/// proxy writes the real client there), otherwise the peer itself, whatever the header says.
pub fn client_address(peer: IpAddr, forwarded_for: Option<&str>, trusted: &[Cidr]) -> String {
    if trusted.iter().any(|c| c.contains(peer))
        && let Some(first) = forwarded_for
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    {
        return first.to_string();
    }
    peer.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn only_the_listed_networks_may_connect_and_the_machine_itself_always_may() {
        let none: Vec<Cidr> = Vec::new();
        assert!(allows(ip("8.8.8.8"), &none), "no list, no filter");
        let team = Cidr::parse_list("192.168.219.0/24, 10.9.9.9");
        assert!(allows(ip("192.168.219.87"), &team));
        assert!(allows(ip("10.9.9.9"), &team));
        assert!(allows(ip("::ffff:192.168.219.5"), &team));
        for outside in [
            "192.168.220.4",
            "192.168.212.9",
            "192.168.218.255",
            "10.9.9.8",
            "8.8.8.8",
        ] {
            assert!(!allows(ip(outside), &team), "{outside}");
        }
        assert!(allows(ip("127.0.0.1"), &team) && allows(ip("::1"), &team));
    }

    #[test]
    fn a_refusal_says_what_the_colony_sees_and_why_localhost_fails() {
        let from_lan = refusal(ip("192.168.220.52"));
        assert!(
            from_lan.contains("it sees you as 192.168.220.52") && !from_lan.contains("localhost")
        );
        let from_docker = refusal(ip("172.19.0.1"));
        assert!(
            from_docker.contains("it sees you as 172.19.0.1")
                && from_docker.contains("not localhost")
        );
        assert!(
            !refusal(ip("172.32.0.1")).contains("localhost"),
            "172.32 is not Docker's range"
        );
    }

    #[test]
    fn ranges_parse_and_match() {
        let list = Cidr::parse_list(PRIVATE_NETWORKS);
        assert_eq!(list.len(), 6);
        for inside in [
            "127.0.0.1",
            "10.1.2.3",
            "172.18.0.5",
            "192.168.1.9",
            "::1",
            "fd00::1",
            "::ffff:172.18.0.5",
        ] {
            assert!(list.iter().any(|c| c.contains(ip(inside))), "{inside}");
        }
        for outside in ["8.8.8.8", "172.32.0.1", "2606:4700::1", "::ffff:8.8.8.8"] {
            assert!(!list.iter().any(|c| c.contains(ip(outside))), "{outside}");
        }
        assert_eq!(Cidr::parse("203.0.113.7").unwrap().prefix, 32);
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(ip("8.8.8.8")));
        assert!(Cidr::parse("10.0.0.0/33").is_none());
        assert!(Cidr::parse("nonsense").is_none());
        assert_eq!(Cidr::parse_list("10.0.0.0/8, bad ,,").len(), 1);
    }

    #[test]
    fn only_a_trusted_peer_chooses_the_client_address() {
        let trusted = Cidr::parse_list(PRIVATE_NETWORKS);
        assert_eq!(
            client_address(ip("172.18.0.3"), Some("198.51.100.4, 172.18.0.1"), &trusted),
            "198.51.100.4"
        );
        assert_eq!(
            client_address(ip("203.0.113.9"), Some("198.51.100.4"), &trusted),
            "203.0.113.9",
            "a caller on the internet cannot pick its address"
        );
        assert_eq!(
            client_address(ip("172.18.0.3"), None, &trusted),
            "172.18.0.3"
        );
        assert_eq!(
            client_address(ip("172.18.0.3"), Some(" "), &trusted),
            "172.18.0.3"
        );
        assert_eq!(
            client_address(ip("10.0.0.2"), Some("198.51.100.4"), &[]),
            "10.0.0.2",
            "an empty list trusts nobody"
        );
    }
}
