use super::{Duration, Error, Instant};

pub const MAX_WEB_SECONDS: u64 = 7 * 24 * 60 * 60;

pub struct Lease {
    pub follows_web: bool,
    deadline: Instant,
    pub expires_unix: u64,
}
impl Lease {
    pub fn new(follows_web: bool, ttl: u64, now: Instant, unix: u64) -> Self {
        Self {
            follows_web,
            deadline: now + Duration::from_secs(ttl),
            expires_unix: unix + ttl,
        }
    }
    pub fn expired(&self, now: Instant) -> bool {
        now >= self.deadline
    }
    pub fn idle_expired(&self, elapsed: Duration, idle_seconds: u64) -> bool {
        !self.follows_web && elapsed > Duration::from_secs(idle_seconds)
    }
    pub fn renew(&mut self, ttl: u64, now: Instant, unix: u64) -> Result<(), Error> {
        // A valid application request can extend a live connection, never revive one.
        if self.expired(now) {
            return Err(Error::expired());
        }
        if self.follows_web {
            self.deadline = now + Duration::from_secs(ttl);
            self.expires_unix = unix + ttl;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn web_connection_survives_idle_and_one_hour_but_not_its_owner_deadline() {
        let now = Instant::now();
        let lease = Lease::new(true, MAX_WEB_SECONDS, now, 1000);
        assert!(!lease.idle_expired(Duration::from_secs(2 * 3600), 900));
        assert!(!lease.expired(now + Duration::from_secs(2 * 3600)));
        assert!(lease.expired(now + Duration::from_secs(MAX_WEB_SECONDS)));
    }
    #[test]
    fn renewal_tracks_the_current_owner_expiry_and_cannot_resurrect_expired_state() {
        let now = Instant::now();
        let mut lease = Lease::new(true, 100, now, 1000);
        assert!(
            lease
                .renew(200, now + Duration::from_secs(50), 1050)
                .is_ok()
        );
        assert_eq!(lease.expires_unix, 1250);
        assert!(!lease.expired(now + Duration::from_secs(200)));
        assert!(
            lease
                .renew(300, now + Duration::from_secs(250), 1250)
                .is_err()
        );
        assert_eq!(lease.expires_unix, 1250);
    }
    #[test]
    fn renewal_can_shorten_a_live_owner_lease() {
        let now = Instant::now();
        let mut lease = Lease::new(true, 100, now, 1000);
        assert!(lease.renew(10, now, 1000).is_ok());
        assert!(lease.expired(now + Duration::from_secs(10)));
    }
    #[test]
    fn legacy_connections_keep_their_idle_and_absolute_limits() {
        let now = Instant::now();
        let mut lease = Lease::new(false, 3600, now, 1000);
        assert!(lease.idle_expired(Duration::from_secs(901), 900));
        assert!(lease.renew(MAX_WEB_SECONDS, now, 1000).is_ok());
        assert_eq!(lease.expires_unix, 4600);
        assert!(lease.expired(now + Duration::from_secs(3600)));
    }
}
