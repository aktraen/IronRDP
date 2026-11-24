//! RemoteApp window state rebuilt from Windowing Alternate Secondary Drawing Orders.

use std::collections::{BTreeMap, BTreeSet};

use ironrdp_pdu::window::{
    DecodedWindowingOrder, WindowExtent, WindowInfoOrder, WindowPoint, WindowRectangle, WindowShowState,
    decode_forwarded_windowing_orders,
};

const WS_POPUP: u32 = 0x8000_0000;
const WS_CAPTION: u32 = 0x00C0_0000;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_APPWINDOW: u32 = 0x0004_0000;

/// How a host should present a RemoteApp window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RailWindowRole {
    /// A top-level application window.
    App,
    /// A window owned by another one (xrdp: a transient window).
    Dialog,
    /// A borderless overlay such as a menu or tooltip (xrdp: an override-redirect window).
    Popup,
}

/// A rectangle in desktop coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RailRect {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

/// The current state of a RemoteApp window, in desktop coordinates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailWindow {
    pub id: u32,
    /// The owning window, when it is not the root window.
    pub owner: Option<u32>,
    pub style: u32,
    pub extended_style: u32,
    pub role: RailWindowRole,
    pub show_state: WindowShowState,
    pub title: String,
    /// Window offset and size.
    pub window_rect: RailRect,
    /// Client area offset and size, when the server sent them.
    pub client_rect: Option<RailRect>,
    pub window_rects: Vec<RailRect>,
    pub visibility_rects: Vec<RailRect>,
}

/// Which parts of a [`RailWindow`] an update changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[expect(clippy::struct_excessive_bools, reason = "one flag per independent window property")]
pub struct RailWindowChanges {
    pub title: bool,
    pub geometry: bool,
    pub visibility: bool,
    pub show_state: bool,
    pub style: bool,
    pub owner: bool,
}

impl RailWindowChanges {
    /// Returns whether any property changed.
    pub const fn any(self) -> bool {
        self.title || self.geometry || self.visibility || self.show_state || self.style || self.owner
    }
}

/// A change to the tracked window set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RailWindowEvent {
    Created(RailWindow),
    /// `reannounced` is set when the server sent the window again as new, which xrdp does for
    /// every mapped window after each Execute (a work area alone re-sends them as plain updates).
    Updated {
        window: RailWindow,
        changes: RailWindowChanges,
        reannounced: bool,
    },
    Deleted {
        id: u32,
    },
}

#[derive(Debug, Clone, Default)]
struct RawWindow {
    owner: u32,
    root_parent: Option<u32>,
    style: u32,
    extended_style: u32,
    show_state: Option<WindowShowState>,
    title: String,
    client_offset: Option<WindowPoint>,
    client_area_size: Option<WindowExtent>,
    window_offset: WindowPoint,
    window_size: WindowExtent,
    window_rects: Vec<WindowRectangle>,
    visible_offset: WindowPoint,
    visibility_rects: Vec<WindowRectangle>,
}

impl RawWindow {
    fn merge(&mut self, order: WindowInfoOrder) {
        if let Some(owner) = order.owner_window_id {
            self.owner = owner;
        }
        if let Some(root_parent) = order.root_parent {
            self.root_parent = Some(root_parent);
        }
        if let Some(styles) = order.styles {
            self.style = styles.style;
            self.extended_style = styles.extended_style;
        }
        if let Some(show_state) = order.show_state {
            self.show_state = Some(show_state);
        }
        if let Some(title) = order.title {
            self.title = title;
        }
        if let Some(offset) = order.client_offset {
            self.client_offset = Some(offset);
        }
        if let Some(size) = order.client_area_size {
            self.client_area_size = Some(size);
        }
        if let Some(offset) = order.window_offset {
            self.window_offset = offset;
        }
        if let Some(size) = order.window_size {
            self.window_size = size;
        }
        if let Some(rects) = order.window_rects {
            self.window_rects = rects;
        }
        if let Some(offset) = order.visible_offset {
            self.visible_offset = offset;
        }
        if let Some(rects) = order.visibility_rects {
            self.visibility_rects = rects;
        }
    }

    fn snapshot(&self, id: u32) -> RailWindow {
        let owner = (self.owner != 0 && Some(self.owner) != self.root_parent).then_some(self.owner);
        RailWindow {
            id,
            owner,
            style: self.style,
            extended_style: self.extended_style,
            role: role(self.style, self.extended_style, owner),
            show_state: self.show_state.unwrap_or(WindowShowState::Shown),
            title: self.title.clone(),
            window_rect: RailRect {
                left: self.window_offset.x,
                top: self.window_offset.y,
                width: self.window_size.width,
                height: self.window_size.height,
            },
            client_rect: self
                .client_offset
                .zip(self.client_area_size)
                .map(|(offset, size)| RailRect {
                    left: offset.x,
                    top: offset.y,
                    width: size.width,
                    height: size.height,
                }),
            window_rects: desktop_rects(self.window_offset, &self.window_rects),
            visibility_rects: desktop_rects(self.visible_offset, &self.visibility_rects),
        }
    }
}

fn role(style: u32, extended_style: u32, owner: Option<u32>) -> RailWindowRole {
    let captionless_popup = style & WS_POPUP != 0 && style & WS_CAPTION != WS_CAPTION;
    if extended_style & WS_EX_TOOLWINDOW != 0 {
        RailWindowRole::Popup
    } else if owner.is_some() || (captionless_popup && extended_style & WS_EX_APPWINDOW != 0) {
        RailWindowRole::Dialog
    } else if captionless_popup {
        RailWindowRole::Popup
    } else {
        RailWindowRole::App
    }
}

fn desktop_rects(offset: WindowPoint, rects: &[WindowRectangle]) -> Vec<RailRect> {
    rects
        .iter()
        .filter_map(|rect| {
            Some(RailRect {
                left: offset.x.checked_add(i32::from(rect.left))?,
                top: offset.y.checked_add(i32::from(rect.top))?,
                width: u32::from(rect.right.checked_sub(rect.left)?),
                height: u32::from(rect.bottom.checked_sub(rect.top)?),
            })
        })
        .collect()
}

fn changes(before: &RailWindow, after: &RailWindow) -> RailWindowChanges {
    RailWindowChanges {
        title: before.title != after.title,
        geometry: before.window_rect != after.window_rect || before.client_rect != after.client_rect,
        visibility: before.window_rects != after.window_rects || before.visibility_rects != after.visibility_rects,
        show_state: before.show_state != after.show_state,
        style: before.style != after.style || before.extended_style != after.extended_style,
        owner: before.owner != after.owner,
    }
}

#[derive(Debug)]
struct TrackedWindow {
    raw: RawWindow,
    snapshot: RailWindow,
}

/// Rebuilds the RemoteApp window set from the orders of `ActiveStageOutput::WindowingOrders`.
#[derive(Debug, Default)]
pub struct RailWindowTracker {
    windows: BTreeMap<u32, TrackedWindow>,
    resync_seen: Option<BTreeSet<u32>>,
    decode_errors: u64,
}

impl RailWindowTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies a forwarded Orders update; an undecodable update is counted and ignored.
    pub fn apply_update(&mut self, forwarded: &[u8]) -> Vec<RailWindowEvent> {
        match decode_forwarded_windowing_orders(forwarded) {
            Ok(orders) => orders.into_iter().filter_map(|order| self.apply(order)).collect(),
            Err(_) => {
                self.decode_errors = self.decode_errors.saturating_add(1);
                Vec::new()
            }
        }
    }

    /// Applies one order. Updates for unknown windows are ignored.
    pub fn apply(&mut self, order: DecodedWindowingOrder) -> Option<RailWindowEvent> {
        match order {
            DecodedWindowingOrder::Window(info) => self.apply_window(info),
            DecodedWindowingOrder::WindowDeleted { window_id } => self.remove(window_id),
            DecodedWindowingOrder::WindowIcon { .. }
            | DecodedWindowingOrder::NotifyIcon { .. }
            | DecodedWindowingOrder::Desktop(_) => None,
        }
    }

    /// Returns the tracked windows ordered by id.
    pub fn windows(&self) -> impl Iterator<Item = &RailWindow> {
        self.windows.values().map(|window| &window.snapshot)
    }

    /// Returns one tracked window.
    pub fn window(&self, id: u32) -> Option<&RailWindow> {
        self.windows.get(&id).map(|window| &window.snapshot)
    }

    /// Starts collecting the windows the server sends again, after it restarted its RAIL state or
    /// received a new work area.
    ///
    /// Any order for a window counts: xrdp re-sends a window with `STATE_NEW` only when an Execute
    /// cleared its window list, and without it when the client merely sent a work area.
    pub fn begin_resync(&mut self) {
        self.resync_seen = Some(BTreeSet::new());
    }

    /// Returns whether a resync is in progress.
    pub fn is_resyncing(&self) -> bool {
        self.resync_seen.is_some()
    }

    /// Deletes the windows the server sent no order for since [`Self::begin_resync`].
    ///
    /// xrdp only re-sends mapped windows, so a window it unmapped (minimized) is deleted here. A
    /// pruned window that the server later updates without `STATE_NEW` stays unknown until the
    /// server announces it as new again.
    pub fn end_resync(&mut self) -> Vec<RailWindowEvent> {
        let Some(seen) = self.resync_seen.take() else {
            return Vec::new();
        };
        let stale = self
            .windows
            .keys()
            .copied()
            .filter(|id| !seen.contains(id))
            .collect::<Vec<_>>();
        stale.into_iter().filter_map(|id| self.remove(id)).collect()
    }

    /// Forgets every window without emitting events.
    pub fn clear(&mut self) {
        self.windows.clear();
        self.resync_seen = None;
    }

    /// Returns how many forwarded updates could not be decoded.
    pub fn decode_errors(&self) -> u64 {
        self.decode_errors
    }

    fn apply_window(&mut self, info: WindowInfoOrder) -> Option<RailWindowEvent> {
        let id = info.window_id;
        let is_new = info.is_new;
        if let Some(seen) = self.resync_seen.as_mut() {
            seen.insert(id);
        }
        match self.windows.get_mut(&id) {
            Some(tracked) => {
                tracked.raw.merge(info);
                let window = tracked.raw.snapshot(id);
                let changes = changes(&tracked.snapshot, &window);
                tracked.snapshot = window.clone();
                (changes.any() || is_new).then_some(RailWindowEvent::Updated {
                    window,
                    changes,
                    reannounced: is_new,
                })
            }
            None if is_new => {
                let mut raw = RawWindow::default();
                raw.merge(info);
                let window = raw.snapshot(id);
                self.windows.insert(
                    id,
                    TrackedWindow {
                        raw,
                        snapshot: window.clone(),
                    },
                );
                Some(RailWindowEvent::Created(window))
            }
            None => None,
        }
    }

    fn remove(&mut self, id: u32) -> Option<RailWindowEvent> {
        self.windows.remove(&id).map(|_| RailWindowEvent::Deleted { id })
    }
}

#[cfg(test)]
mod tests {
    use ironrdp_pdu::window::{
        DecodedWindowingOrder, WindowExtent, WindowInfoOrder, WindowPoint, WindowRectangle, WindowShowState,
        WindowStyles, encode_forwarded_windowing_orders,
    };

    use super::{RailRect, RailWindowChanges, RailWindowEvent, RailWindowRole, RailWindowTracker};

    const ROOT: u32 = 0x221;

    fn rect(width: u16, height: u16) -> Vec<WindowRectangle> {
        vec![WindowRectangle {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        }]
    }

    fn new_window(id: u32, owner: u32, style: u32, extended_style: u32, title: &str) -> DecodedWindowingOrder {
        DecodedWindowingOrder::Window(WindowInfoOrder {
            window_id: id,
            is_new: true,
            owner_window_id: Some(owner),
            styles: Some(WindowStyles { style, extended_style }),
            show_state: Some(WindowShowState::Shown),
            title: Some(title.to_owned()),
            client_offset: Some(WindowPoint::default()),
            client_area_size: Some(WindowExtent {
                width: 750,
                height: 550,
            }),
            root_parent: Some(ROOT),
            window_offset: Some(WindowPoint { x: 20, y: 20 }),
            client_delta: Some(WindowPoint::default()),
            window_size: Some(WindowExtent {
                width: 750,
                height: 550,
            }),
            window_rects: Some(rect(750, 550)),
            visible_offset: Some(WindowPoint { x: 20, y: 20 }),
            visibility_rects: Some(rect(750, 550)),
            ..WindowInfoOrder::default()
        })
    }

    fn app(id: u32, title: &str) -> DecodedWindowingOrder {
        new_window(id, ROOT, 0x00CF_0000, 0x0004_0000, title)
    }

    fn configure(id: u32, x: i32, y: i32, width: u16, height: u16) -> DecodedWindowingOrder {
        DecodedWindowingOrder::Window(WindowInfoOrder {
            window_id: id,
            client_offset: Some(WindowPoint::default()),
            client_area_size: Some(WindowExtent {
                width: u32::from(width),
                height: u32::from(height),
            }),
            root_parent: Some(ROOT),
            window_offset: Some(WindowPoint { x, y }),
            client_delta: Some(WindowPoint::default()),
            window_size: Some(WindowExtent {
                width: u32::from(width),
                height: u32::from(height),
            }),
            window_rects: Some(rect(width, height)),
            visible_offset: Some(WindowPoint { x, y }),
            visibility_rects: Some(rect(width, height)),
            ..WindowInfoOrder::default()
        })
    }

    #[test]
    fn new_window_order_creates_an_app_window() {
        let mut tracker = RailWindowTracker::new();
        let forwarded = encode_forwarded_windowing_orders(&[app(0x0140_0007, "Wireshark")]).unwrap();

        let events = tracker.apply_update(&forwarded);

        let [RailWindowEvent::Created(window)] = events.as_slice() else {
            panic!("expected one created window, got {events:?}");
        };
        assert_eq!(window.id, 0x0140_0007);
        assert_eq!(window.role, RailWindowRole::App);
        assert_eq!(window.owner, None);
        assert_eq!(window.title, "Wireshark");
        assert_eq!(
            window.window_rect,
            RailRect {
                left: 20,
                top: 20,
                width: 750,
                height: 550
            }
        );
        assert_eq!(window.visibility_rects, [window.window_rect]);
        assert_eq!(tracker.windows().count(), 1);

        assert!(tracker.apply_update(&[1, 0, 0, 0]).is_empty());
        assert_eq!(tracker.decode_errors(), 1);
    }

    #[test]
    fn configure_keeps_the_title() {
        let mut tracker = RailWindowTracker::new();
        tracker.apply(app(7, "Mousepad"));

        let event = tracker.apply(configure(7, -10, 40, 400, 300));

        let Some(RailWindowEvent::Updated {
            window,
            changes,
            reannounced: false,
        }) = event
        else {
            panic!("expected an update, got {event:?}");
        };
        assert_eq!(window.title, "Mousepad");
        assert_eq!(
            window.window_rect,
            RailRect {
                left: -10,
                top: 40,
                width: 400,
                height: 300
            }
        );
        assert_eq!(
            window.visibility_rects,
            [RailRect {
                left: -10,
                top: 40,
                width: 400,
                height: 300
            }]
        );
        assert_eq!(
            changes,
            RailWindowChanges {
                geometry: true,
                visibility: true,
                ..RailWindowChanges::default()
            }
        );
        assert_eq!(tracker.apply(configure(7, -10, 40, 400, 300)), None);
    }

    #[test]
    fn show_only_change() {
        let mut tracker = RailWindowTracker::new();
        tracker.apply(app(7, "xterm"));

        let event = tracker.apply(DecodedWindowingOrder::Window(WindowInfoOrder {
            window_id: 7,
            show_state: Some(WindowShowState::Hidden),
            ..WindowInfoOrder::default()
        }));

        let Some(RailWindowEvent::Updated { window, changes, .. }) = event else {
            panic!("expected an update, got {event:?}");
        };
        assert_eq!(window.show_state, WindowShowState::Hidden);
        assert_eq!(
            changes,
            RailWindowChanges {
                show_state: true,
                ..RailWindowChanges::default()
            }
        );
    }

    #[test]
    fn delete_is_reported_once() {
        let mut tracker = RailWindowTracker::new();
        tracker.apply(app(7, "xterm"));

        assert_eq!(
            tracker.apply(DecodedWindowingOrder::WindowDeleted { window_id: 7 }),
            Some(RailWindowEvent::Deleted { id: 7 })
        );
        assert_eq!(
            tracker.apply(DecodedWindowingOrder::WindowDeleted { window_id: 7 }),
            None
        );
        assert!(tracker.window(7).is_none());
    }

    #[test]
    fn transient_window_is_a_dialog() {
        let mut tracker = RailWindowTracker::new();
        tracker.apply(app(7, "Wireshark"));

        let Some(RailWindowEvent::Created(dialog)) =
            tracker.apply(new_window(9, 7, 0x8000_0000, 0x0004_0000, "Open Capture File"))
        else {
            panic!("expected a created dialog");
        };

        assert_eq!(dialog.role, RailWindowRole::Dialog);
        assert_eq!(dialog.owner, Some(7));

        let Some(RailWindowEvent::Created(ownerless)) =
            tracker.apply(new_window(10, ROOT, 0x8000_0000, 0x0004_0000, "About"))
        else {
            panic!("expected a created dialog");
        };
        assert_eq!(ownerless.role, RailWindowRole::Dialog);
        assert_eq!(ownerless.owner, None);
    }

    #[test]
    fn override_redirect_window_is_a_popup() {
        let mut tracker = RailWindowTracker::new();

        let Some(RailWindowEvent::Created(menu)) = tracker.apply(new_window(11, ROOT, 0x8000_0000, 0x88, "title"))
        else {
            panic!("expected a created popup");
        };
        assert_eq!(menu.role, RailWindowRole::Popup);

        let Some(RailWindowEvent::Created(bare)) = tracker.apply(new_window(12, ROOT, 0x8000_0000, 0, "title")) else {
            panic!("expected a created popup");
        };
        assert_eq!(bare.role, RailWindowRole::Popup);
    }

    #[test]
    fn reannounced_window_is_an_update() {
        let mut tracker = RailWindowTracker::new();
        tracker.apply(app(7, "Wireshark"));

        assert_eq!(
            tracker.apply(app(7, "Wireshark")),
            Some(RailWindowEvent::Updated {
                window: tracker.window(7).unwrap().clone(),
                changes: RailWindowChanges::default(),
                reannounced: true,
            })
        );
        assert_eq!(tracker.windows().count(), 1);
    }

    #[test]
    fn resync_prunes_windows_that_were_not_reannounced() {
        let mut tracker = RailWindowTracker::new();
        tracker.apply(app(7, "Wireshark"));
        tracker.apply(app(8, "xterm"));
        assert!(tracker.end_resync().is_empty());

        tracker.begin_resync();
        assert!(tracker.is_resyncing());
        tracker.apply(app(7, "Wireshark"));

        assert_eq!(tracker.end_resync(), [RailWindowEvent::Deleted { id: 8 }]);
        assert!(!tracker.is_resyncing());
        assert_eq!(tracker.windows().map(|window| window.id).collect::<Vec<_>>(), [7]);

        tracker.clear();
        assert_eq!(tracker.windows().count(), 0);
    }

    fn resent(id: u32, title: &str) -> DecodedWindowingOrder {
        let DecodedWindowingOrder::Window(mut order) = app(id, title) else {
            unreachable!("app() builds a window order");
        };
        order.is_new = false;
        DecodedWindowingOrder::Window(order)
    }

    /// xrdp's `rail_restore_windows` re-sends a window still in its list without `STATE_NEW`, so a
    /// client-initiated resync (work area only, no Execute) sees only plain updates.
    #[test]
    fn client_resync_keeps_windows_xrdp_reannounces_without_state_new() {
        let mut tracker = RailWindowTracker::new();
        tracker.apply(app(7, "xterm"));
        tracker.apply(app(8, "Wireshark"));

        tracker.begin_resync();
        tracker.apply(resent(7, "xterm"));
        tracker.apply(configure(8, 0, 0, 10, 10));
        let pruned = tracker.end_resync();

        assert!(pruned.is_empty(), "live windows pruned: {pruned:?}");
        assert_eq!(tracker.windows().count(), 2);
    }

    /// xrdp does not cap the title it converts to UTF-16 (`rail_win_get_text` then libxrdp).
    #[test]
    fn xrdp_new_window_with_long_title_is_decodable() {
        let forwarded = encode_forwarded_windowing_orders(&[app(9, &"x".repeat(300))]).unwrap();
        let mut tracker = RailWindowTracker::new();

        let events = tracker.apply_update(&forwarded);

        let [RailWindowEvent::Created(window)] = events.as_slice() else {
            panic!("window lost: {events:?}, decode_errors={}", tracker.decode_errors());
        };
        assert_eq!(window.title.len(), 260);
    }

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 33
        }

        fn below(&mut self, bound: usize) -> usize {
            usize::try_from(self.next()).unwrap() % bound
        }

        fn byte(&mut self) -> u8 {
            u8::try_from(self.next() & 0xFF).unwrap()
        }
    }

    #[test]
    fn hostile_orders_never_panic() {
        let seed = encode_forwarded_windowing_orders(&[
            app(7, "xterm"),
            DecodedWindowingOrder::WindowDeleted { window_id: 7 },
            resent(8, "t"),
        ])
        .unwrap();
        let mut rng = Lcg(0x5eed);
        let mut tracker = RailWindowTracker::new();
        for round in 0..50_000u32 {
            let mut data = seed.clone();
            for _ in 0..=rng.below(8) {
                let index = rng.below(data.len());
                data[index] = rng.byte();
            }
            if round % 7 == 0 {
                data.truncate(rng.below(data.len()));
            }
            tracker.apply_update(&data);
            if round % 1000 == 0 {
                tracker.begin_resync();
            }
            if round % 1000 == 500 {
                tracker.end_resync();
            }
        }
        let random = core::iter::repeat_with(|| rng.byte()).take(4096).collect::<Vec<_>>();
        for start in 0..random.len() {
            tracker.apply_update(&random[start..]);
        }
    }

    #[test]
    fn update_for_an_unknown_window_is_ignored() {
        let mut tracker = RailWindowTracker::new();

        assert_eq!(tracker.apply(configure(42, 0, 0, 10, 10)), None);
        assert_eq!(
            tracker.apply(DecodedWindowingOrder::WindowIcon {
                window_id: 42,
                cached: false
            }),
            None
        );
        assert_eq!(tracker.windows().count(), 0);
    }
}
