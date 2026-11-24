//! Windowing Alternate Secondary Drawing Orders.
//!
//! These orders are carried by slow-path and Fast-Path Orders updates as defined
//! in [MS-RDPERP] section 2.2.1.3.
//!
//! [MS-RDPERP]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdperp

use ironrdp_core::{DecodeResult, EncodeResult, ReadCursor, ensure_size, invalid_field_err};

const WINDOWING_ORDER_CONTROL_FLAGS: u8 = 0x2e;
const ALTERNATE_SECONDARY_HEADER_SIZE: usize = 1 /* controlFlags */ + 2 /* orderSize */;
const ORDER_FLAGS_SIZE: usize = 4 /* fieldsPresent */;
const WINDOW_HEADER_SIZE: usize = ALTERNATE_SECONDARY_HEADER_SIZE + ORDER_FLAGS_SIZE + 4 /* windowId */;
const NOTIFY_ICON_HEADER_SIZE: usize =
    ALTERNATE_SECONDARY_HEADER_SIZE + ORDER_FLAGS_SIZE + 4 /* windowId */ + 4 /* notifyIconId */;
const DESKTOP_HEADER_SIZE: usize = ALTERNATE_SECONDARY_HEADER_SIZE + ORDER_FLAGS_SIZE;

const WINDOW_TYPE: u32 = 0x0100_0000;
const NOTIFY_ICON_TYPE: u32 = 0x0200_0000;
const DESKTOP_TYPE: u32 = 0x0400_0000;
const ORDER_TYPE_MASK: u32 = WINDOW_TYPE | NOTIFY_ICON_TYPE | DESKTOP_TYPE;

/// A validated Windowing Alternate Secondary Drawing Order.
///
/// The encoded data remains opaque so protocol consumers can apply their own
/// window-management policy without coupling this layer to a presentation API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowingOrder<'a> {
    pub encoded: &'a [u8],
    pub fields_present: u32,
}

macro_rules! skip_if {
    ($src:ident, $flags:expr, $flag:expr, $size:expr) => {
        if $flags & $flag != 0 {
            ensure_size!(in: $src, size: $size);
            $src.advance($size);
        }
    };
}

macro_rules! skip_unicode_if {
    ($src:ident, $flags:expr, $flag:expr, $maximum_size:expr) => {
        if $flags & $flag != 0 {
            skip_unicode($src, $maximum_size)?;
        }
    };
}

macro_rules! skip_rectangles_if {
    ($src:ident, $flags:expr, $flag:expr) => {
        if $flags & $flag != 0 {
            ensure_size!(in: $src, size: 2 /* Rectangle count */);
            let count = usize::from($src.read_u16());
            ensure_size!(in: $src, size: count * 8 /* TS_RECTANGLE_16 */);
            $src.advance(count * 8);
        }
    };
}

impl<'de> WindowingOrder<'de> {
    fn decode(src: &mut ReadCursor<'de>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: ALTERNATE_SECONDARY_HEADER_SIZE);

        let encoded = src.remaining();
        let control_flags = src.read_u8();
        if control_flags != WINDOWING_ORDER_CONTROL_FLAGS {
            return Err(invalid_field_err!(
                "controlFlags",
                "expected a windowing alternate secondary drawing order"
            ));
        }

        let order_size = usize::from(src.read_u16());
        if order_size < DESKTOP_HEADER_SIZE {
            return Err(invalid_field_err!(
                "orderSize",
                "order is smaller than its common header"
            ));
        }

        ensure_size!(in: src, size: order_size - ALTERNATE_SECONDARY_HEADER_SIZE);
        let order_data = src.read_slice(order_size - ALTERNATE_SECONDARY_HEADER_SIZE);
        let mut order_data = ReadCursor::new(order_data);
        ensure_size!(in: order_data, size: ORDER_FLAGS_SIZE);
        let fields_present = order_data.read_u32();
        let header_size = match fields_present & ORDER_TYPE_MASK {
            WINDOW_TYPE => WINDOW_HEADER_SIZE,
            NOTIFY_ICON_TYPE => NOTIFY_ICON_HEADER_SIZE,
            DESKTOP_TYPE => DESKTOP_HEADER_SIZE,
            _ => return Err(invalid_field_err!("fieldsPresent", "invalid windowing order type")),
        };
        if order_size < header_size {
            return Err(invalid_field_err!(
                "orderSize",
                "order is smaller than its typed header"
            ));
        }
        validate_order_fields(fields_present, &mut order_data)?;
        if !order_data.eof() {
            return Err(invalid_field_err!("orderSize", "order contains trailing data"));
        }

        Ok(Self {
            encoded: &encoded[..order_size],
            fields_present,
        })
    }

    /// Returns whether this order requires extended Window List support.
    pub const fn requires_extended_support(self) -> bool {
        self.fields_present
            & (0x0001_0000 /* CLIENTAREASIZE */ | 0x0002_0000 /* RPCONTENT */ | 0x0004_0000/* ROOTPARENT */)
            != 0
    }
}

fn validate_order_fields(fields_present: u32, src: &mut ReadCursor<'_>) -> DecodeResult<()> {
    match fields_present & ORDER_TYPE_MASK {
        WINDOW_TYPE => validate_window_fields(fields_present, src),
        NOTIFY_ICON_TYPE => validate_notification_icon_fields(fields_present, src),
        DESKTOP_TYPE => validate_desktop_fields(fields_present, src),
        _ => unreachable!("the order type was validated by the caller"),
    }
}

fn validate_window_fields(flags: u32, src: &mut ReadCursor<'_>) -> DecodeResult<()> {
    const DELETED: u32 = 0x2000_0000;
    const ICON: u32 = 0x4000_0000;
    const CACHED_ICON: u32 = 0x8000_0000;
    const ICON_FLAGS: u32 = 0x0010_0000 | 0x0000_2000;
    const ALLOWED: u32 = WINDOW_TYPE
        | 0x0000_0001 /* APPBAR_EDGE */
        | 0x0000_0002 /* OWNER */
        | 0x0000_0004 /* TITLE */
        | 0x0000_0008 /* STYLE */
        | 0x0000_0010 /* SHOW */
        | 0x0000_0040 /* APPBAR_STATE */
        | 0x0000_0080 /* RESIZE_MARGIN_X */
        | 0x0000_0100 /* WNDRECTS */
        | 0x0000_0200 /* VISIBILITY */
        | 0x0000_0400 /* WNDSIZE */
        | 0x0000_0800 /* WNDOFFSET */
        | 0x0000_1000 /* VISOFFSET */
        | 0x0000_2000 /* ICON_BIG */
        | 0x0000_4000 /* CLIENTAREAOFFSET */
        | 0x0000_8000 /* CLIENTDELTA */
        | 0x0001_0000 /* CLIENTAREASIZE */
        | 0x0002_0000 /* RPCONTENT */
        | 0x0004_0000 /* ROOTPARENT */
        | 0x0008_0000 /* ENFORCE_SERVER_ZORDER */
        | 0x0010_0000 /* ICON_OVERLAY */
        | 0x0020_0000 /* ICON_OVERLAY_NULL */
        | 0x0040_0000 /* OVERLAY_DESCRIPTION */
        | 0x0080_0000 /* TASKBAR_BUTTON */
        | 0x0800_0000 /* RESIZE_MARGIN_Y */
        | 0x1000_0000 /* STATE_NEW */
        | DELETED
        | ICON
        | CACHED_ICON;

    if flags & !ALLOWED != 0 {
        return Err(invalid_field_err!("fieldsPresent", "unknown window order flag"));
    }
    ensure_size!(in: src, size: 4 /* WindowId */);
    src.advance(4);
    if flags & DELETED != 0 {
        if flags != WINDOW_TYPE | DELETED {
            return Err(invalid_field_err!(
                "fieldsPresent",
                "deleted window order contains additional fields"
            ));
        }
        return Ok(());
    }
    if flags & (ICON | CACHED_ICON) != 0 {
        if flags & (ICON | CACHED_ICON) == ICON | CACHED_ICON {
            return Err(invalid_field_err!(
                "fieldsPresent",
                "window order contains both icon representations"
            ));
        }
        if flags & !(WINDOW_TYPE | 0x1000_0000 | ICON | CACHED_ICON | ICON_FLAGS) != 0 {
            return Err(invalid_field_err!(
                "fieldsPresent",
                "invalid flags for a window icon order"
            ));
        }
        return if flags & ICON != 0 {
            validate_icon(src)
        } else {
            ensure_size!(in: src, size: 3 /* CacheEntry, CacheId */);
            src.advance(3);
            Ok(())
        };
    }

    skip_if!(src, flags, 0x0000_0002, 4 /* OwnerWindowId */);
    skip_if!(src, flags, 0x0000_0008, 8 /* Style, ExtendedStyle */);
    if flags & 0x0000_0010 != 0 {
        ensure_size!(in: src, size: 1 /* ShowState */);
        if !matches!(src.read_u8(), 0 | 2 | 3 | 5) {
            return Err(invalid_field_err!("ShowState", "invalid window show state"));
        }
    }
    // [MS-RDPERP] caps TitleInfo at 520 bytes, but xrdp sends the X11 window name uncapped.
    skip_unicode_if!(src, flags, 0x0000_0004, usize::from(u16::MAX));
    skip_if!(src, flags, 0x0000_4000, 8 /* ClientOffset */);
    skip_if!(src, flags, 0x0001_0000, 8 /* ClientAreaSize */);
    skip_if!(src, flags, 0x0000_0080, 8 /* HorizontalResizeMargins */);
    skip_if!(src, flags, 0x0800_0000, 8 /* VerticalResizeMargins */);
    if flags & 0x0002_0000 != 0 {
        ensure_size!(in: src, size: 1 /* RPContent */);
        if src.read_u8() > 1 {
            return Err(invalid_field_err!("RPContent", "invalid render plugin content"));
        }
    }
    skip_if!(src, flags, 0x0004_0000, 4 /* RootParentHandle */);
    skip_if!(src, flags, 0x0000_0800, 8 /* WindowOffset */);
    skip_if!(src, flags, 0x0000_8000, 8 /* ClientDelta */);
    skip_if!(src, flags, 0x0000_0400, 8 /* WindowSize */);
    skip_rectangles_if!(src, flags, 0x0000_0100);
    skip_if!(src, flags, 0x0000_1000, 8 /* VisibleOffset */);
    skip_rectangles_if!(src, flags, 0x0000_0200);
    skip_unicode_if!(src, flags, 0x0040_0000, usize::from(u16::MAX));
    skip_if!(src, flags, 0x0080_0000, 1 /* TaskbarButton */);
    skip_if!(src, flags, 0x0008_0000, 1 /* EnforceServerZOrder */);
    skip_if!(src, flags, 0x0000_0040, 1 /* AppBarState */);
    skip_if!(src, flags, 0x0000_0001, 1 /* AppBarEdge */);
    Ok(())
}

fn validate_notification_icon_fields(flags: u32, src: &mut ReadCursor<'_>) -> DecodeResult<()> {
    const DELETED: u32 = 0x2000_0000;
    const ICON: u32 = 0x4000_0000;
    const CACHED_ICON: u32 = 0x8000_0000;
    const ALLOWED: u32 = NOTIFY_ICON_TYPE | 0x0000_000F | 0x1000_0000 | DELETED | ICON | CACHED_ICON;
    if flags & !ALLOWED != 0 {
        return Err(invalid_field_err!(
            "fieldsPresent",
            "unknown notification icon order flag"
        ));
    }
    ensure_size!(in: src, size: 8 /* WindowId, NotifyIconId */);
    src.advance(8);
    if flags & DELETED != 0 {
        if flags != NOTIFY_ICON_TYPE | DELETED {
            return Err(invalid_field_err!(
                "fieldsPresent",
                "deleted notification icon contains additional fields"
            ));
        }
        return Ok(());
    }
    if flags & (ICON | CACHED_ICON) == ICON | CACHED_ICON {
        return Err(invalid_field_err!(
            "fieldsPresent",
            "notification icon contains both icon representations"
        ));
    }
    if flags & 0x1000_0000 != 0 && flags & (ICON | CACHED_ICON) == 0 {
        return Err(invalid_field_err!(
            "fieldsPresent",
            "new notification icon has no icon representation"
        ));
    }
    if flags & 0x0000_0008 != 0 {
        ensure_size!(in: src, size: 4 /* Version */);
        if !matches!(src.read_u32(), 0 | 3 | 4) {
            return Err(invalid_field_err!("Version", "unsupported notification icon version"));
        }
    }
    skip_unicode_if!(src, flags, 0x0000_0001, usize::from(u16::MAX));
    if flags & 0x0000_0002 != 0 {
        ensure_size!(in: src, size: 8 /* Timeout, InfoFlags */);
        src.advance(4);
        let info_flags = src.read_u32();
        if info_flags & !0x33 != 0 || !matches!(info_flags & 0x0F, 0..=3) {
            return Err(invalid_field_err!(
                "InfoFlags",
                "invalid notification icon info tip flags"
            ));
        }
        skip_unicode(src, 510)?;
        skip_unicode(src, 126)?;
    }
    if flags & 0x0000_0004 != 0 {
        ensure_size!(in: src, size: 4 /* State */);
        if src.read_u32() & !1 != 0 {
            return Err(invalid_field_err!("State", "unknown notification icon state"));
        }
    }
    if flags & ICON != 0 {
        validate_icon(src)?;
    } else if flags & CACHED_ICON != 0 {
        ensure_size!(in: src, size: 3 /* CacheEntry, CacheId */);
        src.advance(3);
    }
    Ok(())
}

fn validate_desktop_fields(flags: u32, src: &mut ReadCursor<'_>) -> DecodeResult<()> {
    const ALLOWED: u32 = DESKTOP_TYPE | 0x3F;
    if flags & !ALLOWED != 0 {
        return Err(invalid_field_err!("fieldsPresent", "unknown desktop order flag"));
    }
    if flags & 1 != 0 {
        if flags != DESKTOP_TYPE | 1 {
            return Err(invalid_field_err!(
                "fieldsPresent",
                "non-monitored desktop contains additional fields"
            ));
        }
        return Ok(());
    }
    if flags & 8 != 0 && flags & 2 == 0 {
        return Err(invalid_field_err!("fieldsPresent", "desktop ARC began requires hooked"));
    }
    if flags & 4 != 0 && flags != DESKTOP_TYPE | 4 {
        return Err(invalid_field_err!(
            "fieldsPresent",
            "desktop ARC completed contains additional fields"
        ));
    }
    skip_if!(src, flags, 0x20, 4 /* ActiveWindowId */);
    if flags & 0x10 != 0 {
        ensure_size!(in: src, size: 1 /* NumWindowIds */);
        let count = usize::from(src.read_u8());
        ensure_size!(in: src, size: count * 4 /* WindowIds */);
        src.advance(count * 4);
    }
    Ok(())
}

fn validate_icon(src: &mut ReadCursor<'_>) -> DecodeResult<()> {
    ensure_size!(in: src, size: 8 /* fixed icon fields */);
    src.advance(3);
    let bpp = src.read_u8();
    if !matches!(bpp, 1 | 4 | 8 | 16 | 24 | 32) {
        return Err(invalid_field_err!("Bpp", "unsupported icon color depth"));
    }
    src.advance(4);
    let color_table_len = if matches!(bpp, 1 | 4 | 8) {
        ensure_size!(in: src, size: 2 /* CbColorTable */);
        usize::from(src.read_u16())
    } else {
        0
    };
    ensure_size!(in: src, size: 4 /* CbBitsMask, CbBitsColor */);
    let mask_len = usize::from(src.read_u16());
    let color_len = usize::from(src.read_u16());
    ensure_size!(in: src, size: color_table_len + mask_len + color_len);
    src.advance(color_table_len + mask_len + color_len);
    Ok(())
}

fn skip_unicode(src: &mut ReadCursor<'_>, maximum_size: usize) -> DecodeResult<()> {
    ensure_size!(in: src, size: 2 /* CbString */);
    let size = usize::from(src.read_u16());
    if size % 2 != 0 || size > maximum_size {
        return Err(invalid_field_err!("CbString", "invalid UTF-16 string length"));
    }
    ensure_size!(in: src, size: size);
    let bytes = src.read_slice(size);
    let code_units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&code_units).map_err(|_| invalid_field_err!("String", "invalid UTF-16 string"))?;
    Ok(())
}

/// A validated collection of Windowing Alternate Secondary Drawing Orders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowingOrdersUpdate<'a> {
    pub orders: Vec<WindowingOrder<'a>>,
    /// Whether the source update also contains drawing orders outside the
    /// Windowing Alternate Secondary subset.
    ///
    /// Their framing is stateful, so they remain in the encoded update for the
    /// consumer instead of being discarded while scanning for window orders.
    pub contains_non_window_orders: bool,
}

/// Parses a slow-path Orders update after its `updateType` field.
///
pub fn try_decode_slow_path_windowing_orders<'a>(src: &mut ReadCursor<'a>) -> DecodeResult<WindowingOrdersUpdate<'a>> {
    ensure_size!(in: src, size: 2 /* pad2OctetsA */ + 2 /* numberOrders */ + 2 /* pad2OctetsB */);
    src.advance(2);
    let order_count = usize::from(src.read_u16());
    src.advance(2);
    decode_orders(src, order_count)
}

/// Parses a Fast-Path Orders update after its Fast-Path framing.
///
pub fn try_decode_fast_path_windowing_orders<'a>(src: &mut ReadCursor<'a>) -> DecodeResult<WindowingOrdersUpdate<'a>> {
    ensure_size!(in: src, size: 2 /* numberOrders */);
    let order_count = usize::from(src.read_u16());
    decode_orders(src, order_count)
}

fn decode_orders<'a>(src: &mut ReadCursor<'a>, order_count: usize) -> DecodeResult<WindowingOrdersUpdate<'a>> {
    let mut orders = Vec::with_capacity(order_count);
    for _ in 0..order_count {
        if src.remaining().first().copied() != Some(WINDOWING_ORDER_CONTROL_FLAGS) {
            return Ok(WindowingOrdersUpdate {
                orders,
                contains_non_window_orders: true,
            });
        }
        orders.push(WindowingOrder::decode(src)?);
    }
    if !src.eof() {
        return Err(invalid_field_err!("orderData", "orders update contains trailing data"));
    }

    Ok(WindowingOrdersUpdate {
        orders,
        contains_non_window_orders: false,
    })
}

const FIELD_APPBAR_EDGE: u32 = 0x0000_0001;
const FIELD_OWNER: u32 = 0x0000_0002;
const FIELD_TITLE: u32 = 0x0000_0004;
const FIELD_STYLE: u32 = 0x0000_0008;
const FIELD_SHOW: u32 = 0x0000_0010;
const FIELD_APPBAR_STATE: u32 = 0x0000_0040;
const FIELD_RESIZE_MARGIN_X: u32 = 0x0000_0080;
const FIELD_WND_RECTS: u32 = 0x0000_0100;
const FIELD_VISIBILITY: u32 = 0x0000_0200;
const FIELD_WND_SIZE: u32 = 0x0000_0400;
const FIELD_WND_OFFSET: u32 = 0x0000_0800;
const FIELD_VIS_OFFSET: u32 = 0x0000_1000;
const FIELD_CLIENT_AREA_OFFSET: u32 = 0x0000_4000;
const FIELD_WND_CLIENT_DELTA: u32 = 0x0000_8000;
const FIELD_CLIENT_AREA_SIZE: u32 = 0x0001_0000;
const FIELD_RP_CONTENT: u32 = 0x0002_0000;
const FIELD_ROOT_PARENT: u32 = 0x0004_0000;
const FIELD_ENFORCE_SERVER_ZORDER: u32 = 0x0008_0000;
const FIELD_OVERLAY_DESCRIPTION: u32 = 0x0040_0000;
const FIELD_TASKBAR_BUTTON: u32 = 0x0080_0000;
const FIELD_RESIZE_MARGIN_Y: u32 = 0x0800_0000;
const STATE_NEW: u32 = 0x1000_0000;
const STATE_DELETED: u32 = 0x2000_0000;
const FIELD_ICON: u32 = 0x4000_0000;
const FIELD_CACHED_ICON: u32 = 0x8000_0000;

const DESKTOP_NONE: u32 = 0x0000_0001;
const DESKTOP_HOOKED: u32 = 0x0000_0002;
const DESKTOP_ARC_COMPLETED: u32 = 0x0000_0004;
const DESKTOP_ARC_BEGAN: u32 = 0x0000_0008;
const DESKTOP_ZORDER: u32 = 0x0000_0010;
const DESKTOP_ACTIVE_WINDOW: u32 = 0x0000_0020;

/// `GRAPHICS_UPDATE_TYPE_ORDERS`, the first field of a forwarded Orders update.
const UPDATE_TYPE_ORDERS: u16 = 0x0000;

/// The longest title [MS-RDPERP] allows (520 bytes); [`decode_windowing_order`] truncates longer ones.
pub const MAX_TITLE_CODE_UNITS: usize = 260;

fn truncate_utf16(value: String, max_code_units: usize) -> String {
    let mut code_units = 0;
    for (index, character) in value.char_indices() {
        code_units += character.len_utf16();
        if code_units > max_code_units {
            let mut truncated = value;
            truncated.truncate(index);
            return truncated;
        }
    }
    value
}

/// Show state of a RemoteApp window ([MS-RDPERP] 2.2.1.3.1.2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowShowState {
    Hidden,
    Minimized,
    Maximized,
    Shown,
}

impl WindowShowState {
    fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Hidden),
            2 => Some(Self::Minimized),
            3 => Some(Self::Maximized),
            5 => Some(Self::Shown),
            _ => None,
        }
    }

    const fn as_u8(self) -> u8 {
        match self {
            Self::Hidden => 0,
            Self::Minimized => 2,
            Self::Maximized => 3,
            Self::Shown => 5,
        }
    }
}

/// A signed point in virtual desktop coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowPoint {
    pub x: i32,
    pub y: i32,
}

/// An unsigned window extent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowExtent {
    pub width: u32,
    pub height: u32,
}

/// A `TS_RECTANGLE_16` relative to its window or visible offset; `right` and `bottom` are exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowRectangle {
    pub left: u16,
    pub top: u16,
    pub right: u16,
    pub bottom: u16,
}

/// A pair of resize margins (left/right or top/bottom).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowResizeMargins {
    pub start: u32,
    pub end: u32,
}

/// Window styles as sent by the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowStyles {
    pub style: u32,
    pub extended_style: u32,
}

/// A decoded Window Information Order ([MS-RDPERP] 2.2.1.3.1.2.1), new window or update.
///
/// Every optional field is `Some` exactly when its `fieldsPresent` flag was set.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WindowInfoOrder {
    pub window_id: u32,
    pub is_new: bool,
    pub owner_window_id: Option<u32>,
    pub styles: Option<WindowStyles>,
    pub show_state: Option<WindowShowState>,
    /// At most [`MAX_TITLE_CODE_UNITS`] UTF-16 code units: longer titles are truncated when decoding.
    pub title: Option<String>,
    pub client_offset: Option<WindowPoint>,
    pub client_area_size: Option<WindowExtent>,
    pub horizontal_resize_margins: Option<WindowResizeMargins>,
    pub vertical_resize_margins: Option<WindowResizeMargins>,
    pub rp_content: Option<bool>,
    pub root_parent: Option<u32>,
    pub window_offset: Option<WindowPoint>,
    pub client_delta: Option<WindowPoint>,
    pub window_size: Option<WindowExtent>,
    pub window_rects: Option<Vec<WindowRectangle>>,
    pub visible_offset: Option<WindowPoint>,
    pub visibility_rects: Option<Vec<WindowRectangle>>,
    pub overlay_description: Option<String>,
    pub taskbar_button: Option<u8>,
    pub enforce_server_z_order: Option<u8>,
    pub app_bar_state: Option<u8>,
    pub app_bar_edge: Option<u8>,
}

/// A decoded Desktop Information Order ([MS-RDPERP] 2.2.1.3.3.2).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DesktopInfoOrder {
    pub non_monitored: bool,
    pub hooked: bool,
    pub arc_began: bool,
    pub arc_completed: bool,
    pub active_window_id: Option<u32>,
    pub z_order: Option<Vec<u32>>,
}

/// A typed Windowing Alternate Secondary Drawing Order.
///
/// Icon payloads are validated but not retained: RemoteApp hosts that draw their own chrome do
/// not need them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedWindowingOrder {
    Window(WindowInfoOrder),
    WindowDeleted {
        window_id: u32,
    },
    WindowIcon {
        window_id: u32,
        cached: bool,
    },
    NotifyIcon {
        window_id: u32,
        notify_icon_id: u32,
        deleted: bool,
    },
    Desktop(DesktopInfoOrder),
}

impl WindowingOrder<'_> {
    /// Decodes the fields of this validated order.
    pub fn decode_typed(&self) -> DecodeResult<DecodedWindowingOrder> {
        decode_windowing_order(&mut ReadCursor::new(self.encoded))
    }
}

/// Validates and decodes one Windowing Alternate Secondary Drawing Order.
pub fn decode_windowing_order(src: &mut ReadCursor<'_>) -> DecodeResult<DecodedWindowingOrder> {
    let order = WindowingOrder::decode(src)?;
    let mut body = ReadCursor::new(order.encoded);
    body.advance(ALTERNATE_SECONDARY_HEADER_SIZE + ORDER_FLAGS_SIZE);
    let flags = order.fields_present;
    match flags & ORDER_TYPE_MASK {
        WINDOW_TYPE => decode_window_order(flags, &mut body),
        NOTIFY_ICON_TYPE => {
            ensure_size!(in: body, size: 8 /* WindowId, NotifyIconId */);
            Ok(DecodedWindowingOrder::NotifyIcon {
                window_id: body.read_u32(),
                notify_icon_id: body.read_u32(),
                deleted: flags & STATE_DELETED != 0,
            })
        }
        _ => decode_desktop_order(flags, &mut body).map(DecodedWindowingOrder::Desktop),
    }
}

/// Decodes the window orders of a forwarded Orders update.
///
/// The payload is the one carried by `ActiveStageOutput::WindowingOrders`: a slow-path Orders
/// graphics update starting with its `updateType`. Orders outside the windowing subset end the
/// scan, exactly like [`try_decode_slow_path_windowing_orders`].
pub fn decode_forwarded_windowing_orders(data: &[u8]) -> DecodeResult<Vec<DecodedWindowingOrder>> {
    let mut src = ReadCursor::new(data);
    ensure_size!(in: src, size: 2 /* updateType */);
    if src.read_u16() != UPDATE_TYPE_ORDERS {
        return Err(invalid_field_err!("updateType", "expected an Orders update"));
    }
    try_decode_slow_path_windowing_orders(&mut src)?
        .orders
        .iter()
        .map(WindowingOrder::decode_typed)
        .collect()
}

/// Encodes orders as a forwarded Orders update (the inverse of [`decode_forwarded_windowing_orders`]).
///
/// Icon orders cannot be encoded because their payload is not retained when decoding.
pub fn encode_forwarded_windowing_orders(orders: &[DecodedWindowingOrder]) -> EncodeResult<Vec<u8>> {
    let count = u16::try_from(orders.len()).map_err(|_| invalid_field_err!("numberOrders", "too many orders"))?;
    let mut out = Vec::new();
    out.extend_from_slice(&UPDATE_TYPE_ORDERS.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    for order in orders {
        out.extend_from_slice(&order.encode_order()?);
    }
    Ok(out)
}

impl DecodedWindowingOrder {
    /// Encodes this order with its alternate secondary drawing order header.
    pub fn encode_order(&self) -> EncodeResult<Vec<u8>> {
        let mut fields = Vec::new();
        let fields_present = match self {
            Self::Window(window) => window.encode_fields(&mut fields)?,
            Self::WindowDeleted { window_id } => {
                fields.extend_from_slice(&window_id.to_le_bytes());
                WINDOW_TYPE | STATE_DELETED
            }
            Self::Desktop(desktop) => desktop.encode_fields(&mut fields)?,
            Self::WindowIcon { .. } | Self::NotifyIcon { .. } => {
                return Err(invalid_field_err!("fieldsPresent", "icon orders are not encodable"));
            }
        };
        let order_size = ALTERNATE_SECONDARY_HEADER_SIZE + ORDER_FLAGS_SIZE + fields.len();
        let order_size =
            u16::try_from(order_size).map_err(|_| invalid_field_err!("orderSize", "order does not fit in 64 KiB"))?;
        let mut out = Vec::with_capacity(usize::from(order_size));
        out.push(WINDOWING_ORDER_CONTROL_FLAGS);
        out.extend_from_slice(&order_size.to_le_bytes());
        out.extend_from_slice(&fields_present.to_le_bytes());
        out.extend_from_slice(&fields);
        Ok(out)
    }
}

impl WindowInfoOrder {
    fn encode_fields(&self, out: &mut Vec<u8>) -> EncodeResult<u32> {
        let mut flags = WINDOW_TYPE;
        if self.is_new {
            flags |= STATE_NEW;
        }
        out.extend_from_slice(&self.window_id.to_le_bytes());
        if let Some(owner) = self.owner_window_id {
            flags |= FIELD_OWNER;
            out.extend_from_slice(&owner.to_le_bytes());
        }
        if let Some(styles) = self.styles {
            flags |= FIELD_STYLE;
            out.extend_from_slice(&styles.style.to_le_bytes());
            out.extend_from_slice(&styles.extended_style.to_le_bytes());
        }
        if let Some(show_state) = self.show_state {
            flags |= FIELD_SHOW;
            out.push(show_state.as_u8());
        }
        if let Some(title) = &self.title {
            flags |= FIELD_TITLE;
            encode_unicode(out, title)?;
        }
        if let Some(offset) = self.client_offset {
            flags |= FIELD_CLIENT_AREA_OFFSET;
            encode_point(out, offset);
        }
        if let Some(size) = self.client_area_size {
            flags |= FIELD_CLIENT_AREA_SIZE;
            encode_extent(out, size);
        }
        if let Some(margins) = self.horizontal_resize_margins {
            flags |= FIELD_RESIZE_MARGIN_X;
            encode_margins(out, margins);
        }
        if let Some(margins) = self.vertical_resize_margins {
            flags |= FIELD_RESIZE_MARGIN_Y;
            encode_margins(out, margins);
        }
        if let Some(rp_content) = self.rp_content {
            flags |= FIELD_RP_CONTENT;
            out.push(u8::from(rp_content));
        }
        if let Some(root_parent) = self.root_parent {
            flags |= FIELD_ROOT_PARENT;
            out.extend_from_slice(&root_parent.to_le_bytes());
        }
        if let Some(offset) = self.window_offset {
            flags |= FIELD_WND_OFFSET;
            encode_point(out, offset);
        }
        if let Some(delta) = self.client_delta {
            flags |= FIELD_WND_CLIENT_DELTA;
            encode_point(out, delta);
        }
        if let Some(size) = self.window_size {
            flags |= FIELD_WND_SIZE;
            encode_extent(out, size);
        }
        if let Some(rects) = &self.window_rects {
            flags |= FIELD_WND_RECTS;
            encode_rectangles(out, rects)?;
        }
        if let Some(offset) = self.visible_offset {
            flags |= FIELD_VIS_OFFSET;
            encode_point(out, offset);
        }
        if let Some(rects) = &self.visibility_rects {
            flags |= FIELD_VISIBILITY;
            encode_rectangles(out, rects)?;
        }
        if let Some(description) = &self.overlay_description {
            flags |= FIELD_OVERLAY_DESCRIPTION;
            encode_unicode(out, description)?;
        }
        for (flag, value) in [
            (FIELD_TASKBAR_BUTTON, self.taskbar_button),
            (FIELD_ENFORCE_SERVER_ZORDER, self.enforce_server_z_order),
            (FIELD_APPBAR_STATE, self.app_bar_state),
            (FIELD_APPBAR_EDGE, self.app_bar_edge),
        ] {
            if let Some(value) = value {
                flags |= flag;
                out.push(value);
            }
        }
        Ok(flags)
    }
}

impl DesktopInfoOrder {
    fn encode_fields(&self, out: &mut Vec<u8>) -> EncodeResult<u32> {
        let mut flags = DESKTOP_TYPE;
        for (flag, set) in [
            (DESKTOP_NONE, self.non_monitored),
            (DESKTOP_HOOKED, self.hooked),
            (DESKTOP_ARC_BEGAN, self.arc_began),
            (DESKTOP_ARC_COMPLETED, self.arc_completed),
        ] {
            if set {
                flags |= flag;
            }
        }
        if let Some(active) = self.active_window_id {
            flags |= DESKTOP_ACTIVE_WINDOW;
            out.extend_from_slice(&active.to_le_bytes());
        }
        if let Some(z_order) = &self.z_order {
            flags |= DESKTOP_ZORDER;
            out.push(u8::try_from(z_order.len()).map_err(|_| invalid_field_err!("NumWindowIds", "too many windows"))?);
            for id in z_order {
                out.extend_from_slice(&id.to_le_bytes());
            }
        }
        Ok(flags)
    }
}

fn decode_window_order(flags: u32, src: &mut ReadCursor<'_>) -> DecodeResult<DecodedWindowingOrder> {
    ensure_size!(in: src, size: 4 /* WindowId */);
    let window_id = src.read_u32();
    if flags & STATE_DELETED != 0 {
        return Ok(DecodedWindowingOrder::WindowDeleted { window_id });
    }
    if flags & (FIELD_ICON | FIELD_CACHED_ICON) != 0 {
        return Ok(DecodedWindowingOrder::WindowIcon {
            window_id,
            cached: flags & FIELD_CACHED_ICON != 0,
        });
    }

    let mut order = WindowInfoOrder {
        window_id,
        is_new: flags & STATE_NEW != 0,
        ..WindowInfoOrder::default()
    };
    if flags & FIELD_OWNER != 0 {
        order.owner_window_id = Some(read_u32(src)?);
    }
    if flags & FIELD_STYLE != 0 {
        order.styles = Some(WindowStyles {
            style: read_u32(src)?,
            extended_style: read_u32(src)?,
        });
    }
    if flags & FIELD_SHOW != 0 {
        ensure_size!(in: src, size: 1 /* ShowState */);
        order.show_state = Some(
            WindowShowState::from_u8(src.read_u8())
                .ok_or_else(|| invalid_field_err!("ShowState", "invalid window show state"))?,
        );
    }
    if flags & FIELD_TITLE != 0 {
        order.title = Some(truncate_utf16(
            decode_unicode(src, usize::from(u16::MAX))?,
            MAX_TITLE_CODE_UNITS,
        ));
    }
    if flags & FIELD_CLIENT_AREA_OFFSET != 0 {
        order.client_offset = Some(read_point(src)?);
    }
    if flags & FIELD_CLIENT_AREA_SIZE != 0 {
        order.client_area_size = Some(read_extent(src)?);
    }
    if flags & FIELD_RESIZE_MARGIN_X != 0 {
        order.horizontal_resize_margins = Some(read_margins(src)?);
    }
    if flags & FIELD_RESIZE_MARGIN_Y != 0 {
        order.vertical_resize_margins = Some(read_margins(src)?);
    }
    if flags & FIELD_RP_CONTENT != 0 {
        ensure_size!(in: src, size: 1 /* RPContent */);
        order.rp_content = Some(src.read_u8() != 0);
    }
    if flags & FIELD_ROOT_PARENT != 0 {
        order.root_parent = Some(read_u32(src)?);
    }
    if flags & FIELD_WND_OFFSET != 0 {
        order.window_offset = Some(read_point(src)?);
    }
    if flags & FIELD_WND_CLIENT_DELTA != 0 {
        order.client_delta = Some(read_point(src)?);
    }
    if flags & FIELD_WND_SIZE != 0 {
        order.window_size = Some(read_extent(src)?);
    }
    if flags & FIELD_WND_RECTS != 0 {
        order.window_rects = Some(read_rectangles(src)?);
    }
    if flags & FIELD_VIS_OFFSET != 0 {
        order.visible_offset = Some(read_point(src)?);
    }
    if flags & FIELD_VISIBILITY != 0 {
        order.visibility_rects = Some(read_rectangles(src)?);
    }
    if flags & FIELD_OVERLAY_DESCRIPTION != 0 {
        order.overlay_description = Some(decode_unicode(src, usize::from(u16::MAX))?);
    }
    order.taskbar_button = read_optional_u8(src, flags, FIELD_TASKBAR_BUTTON)?;
    order.enforce_server_z_order = read_optional_u8(src, flags, FIELD_ENFORCE_SERVER_ZORDER)?;
    order.app_bar_state = read_optional_u8(src, flags, FIELD_APPBAR_STATE)?;
    order.app_bar_edge = read_optional_u8(src, flags, FIELD_APPBAR_EDGE)?;
    Ok(DecodedWindowingOrder::Window(order))
}

fn decode_desktop_order(flags: u32, src: &mut ReadCursor<'_>) -> DecodeResult<DesktopInfoOrder> {
    let mut order = DesktopInfoOrder {
        non_monitored: flags & DESKTOP_NONE != 0,
        hooked: flags & DESKTOP_HOOKED != 0,
        arc_began: flags & DESKTOP_ARC_BEGAN != 0,
        arc_completed: flags & DESKTOP_ARC_COMPLETED != 0,
        ..DesktopInfoOrder::default()
    };
    if flags & DESKTOP_ACTIVE_WINDOW != 0 {
        order.active_window_id = Some(read_u32(src)?);
    }
    if flags & DESKTOP_ZORDER != 0 {
        ensure_size!(in: src, size: 1 /* NumWindowIds */);
        let count = usize::from(src.read_u8());
        ensure_size!(in: src, size: count * 4 /* WindowIds */);
        order.z_order = Some(core::iter::repeat_with(|| src.read_u32()).take(count).collect());
    }
    Ok(order)
}

fn read_u32(src: &mut ReadCursor<'_>) -> DecodeResult<u32> {
    ensure_size!(in: src, size: 4);
    Ok(src.read_u32())
}

fn read_optional_u8(src: &mut ReadCursor<'_>, flags: u32, flag: u32) -> DecodeResult<Option<u8>> {
    if flags & flag == 0 {
        return Ok(None);
    }
    ensure_size!(in: src, size: 1);
    Ok(Some(src.read_u8()))
}

fn read_point(src: &mut ReadCursor<'_>) -> DecodeResult<WindowPoint> {
    ensure_size!(in: src, size: 8);
    Ok(WindowPoint {
        x: src.read_i32(),
        y: src.read_i32(),
    })
}

fn read_extent(src: &mut ReadCursor<'_>) -> DecodeResult<WindowExtent> {
    ensure_size!(in: src, size: 8);
    Ok(WindowExtent {
        width: src.read_u32(),
        height: src.read_u32(),
    })
}

fn read_margins(src: &mut ReadCursor<'_>) -> DecodeResult<WindowResizeMargins> {
    ensure_size!(in: src, size: 8);
    Ok(WindowResizeMargins {
        start: src.read_u32(),
        end: src.read_u32(),
    })
}

fn read_rectangles(src: &mut ReadCursor<'_>) -> DecodeResult<Vec<WindowRectangle>> {
    ensure_size!(in: src, size: 2 /* count */);
    let count = usize::from(src.read_u16());
    ensure_size!(in: src, size: count * 8 /* TS_RECTANGLE_16 */);
    Ok(core::iter::repeat_with(|| WindowRectangle {
        left: src.read_u16(),
        top: src.read_u16(),
        right: src.read_u16(),
        bottom: src.read_u16(),
    })
    .take(count)
    .collect())
}

fn decode_unicode(src: &mut ReadCursor<'_>, maximum_size: usize) -> DecodeResult<String> {
    ensure_size!(in: src, size: 2 /* CbString */);
    let size = usize::from(src.read_u16());
    if size % 2 != 0 || size > maximum_size {
        return Err(invalid_field_err!("CbString", "invalid UTF-16 string length"));
    }
    ensure_size!(in: src, size: size);
    let code_units = src
        .read_slice(size)
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&code_units).map_err(|_| invalid_field_err!("String", "invalid UTF-16 string"))
}

fn encode_unicode(out: &mut Vec<u8>, value: &str) -> EncodeResult<()> {
    let bytes = value.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    let size = u16::try_from(bytes.len()).map_err(|_| invalid_field_err!("CbString", "string is too long"))?;
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&bytes);
    Ok(())
}

fn encode_point(out: &mut Vec<u8>, point: WindowPoint) {
    out.extend_from_slice(&point.x.to_le_bytes());
    out.extend_from_slice(&point.y.to_le_bytes());
}

fn encode_extent(out: &mut Vec<u8>, extent: WindowExtent) {
    out.extend_from_slice(&extent.width.to_le_bytes());
    out.extend_from_slice(&extent.height.to_le_bytes());
}

fn encode_margins(out: &mut Vec<u8>, margins: WindowResizeMargins) {
    out.extend_from_slice(&margins.start.to_le_bytes());
    out.extend_from_slice(&margins.end.to_le_bytes());
}

fn encode_rectangles(out: &mut Vec<u8>, rects: &[WindowRectangle]) -> EncodeResult<()> {
    let count = u16::try_from(rects.len()).map_err(|_| invalid_field_err!("NumRects", "too many rectangles"))?;
    out.extend_from_slice(&count.to_le_bytes());
    for rect in rects {
        for value in [rect.left, rect.top, rect.right, rect.bottom] {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deleted_window_order() -> [u8; 11] {
        [WINDOWING_ORDER_CONTROL_FLAGS, 11, 0, 0, 0, 0, 0x21, 7, 0, 0, 0]
    }

    #[test]
    fn parses_slow_path_windowing_order() {
        let order = deleted_window_order();
        let mut update = vec![0, 0, 1, 0, 0, 0];
        update.extend_from_slice(&order);

        let orders = try_decode_slow_path_windowing_orders(&mut ReadCursor::new(&update)).unwrap();
        assert_eq!(orders.orders.len(), 1);
        assert_eq!(orders.orders[0].encoded, order.as_slice());
        assert!(!orders.orders[0].requires_extended_support());
    }

    #[test]
    fn parses_fast_path_windowing_order() {
        let order = deleted_window_order();
        let mut update = vec![1, 0];
        update.extend_from_slice(&order);

        let orders = try_decode_fast_path_windowing_orders(&mut ReadCursor::new(&update)).unwrap();
        assert_eq!(orders.orders[0].encoded, order.as_slice());
    }

    #[test]
    fn rejects_malformed_windowing_order() {
        let mut malformed = deleted_window_order();
        malformed[1] = 12;
        let mut update = vec![1, 0];
        update.extend_from_slice(&malformed);

        assert!(try_decode_fast_path_windowing_orders(&mut ReadCursor::new(&update)).is_err());
    }

    #[test]
    fn rejects_window_order_with_truncated_optional_field() {
        let mut order = deleted_window_order();
        order[3..7].copy_from_slice(&(WINDOW_TYPE | 0x0000_0004/* TITLE */).to_le_bytes());
        let mut update = vec![1, 0];
        update.extend_from_slice(&order);

        assert!(try_decode_fast_path_windowing_orders(&mut ReadCursor::new(&update)).is_err());
    }

    #[test]
    fn preserves_mixed_order_updates_for_consumers() {
        let mut update = vec![2, 0];
        update.extend_from_slice(&deleted_window_order());
        update.push(0);

        let orders = try_decode_fast_path_windowing_orders(&mut ReadCursor::new(&update)).unwrap();
        assert_eq!(orders.orders.len(), 1);
        assert!(orders.contains_non_window_orders);
    }

    /// An xrdp 0.10 new-window order for Wireshark (window 0x1400007 owned by root window 0x221).
    ///
    /// Assembled from the field set of xrdp's `rail_create_window`.
    const XRDP_NEW_WINDOW_ORDER: [u8; 158] = [
        0x2e, 0x9e, 0x00, 0x1e, 0xdf, 0x05, 0x11, 0x07, 0x00, 0x40, 0x01, 0x21, 0x02, 0x00, 0x00, 0x00, 0x00, 0xcf,
        0x00, 0x00, 0x00, 0x04, 0x00, 0x05, 0x3c, 0x00, 0x54, 0x00, 0x68, 0x00, 0x65, 0x00, 0x20, 0x00, 0x57, 0x00,
        0x69, 0x00, 0x72, 0x00, 0x65, 0x00, 0x73, 0x00, 0x68, 0x00, 0x61, 0x00, 0x72, 0x00, 0x6b, 0x00, 0x20, 0x00,
        0x4e, 0x00, 0x65, 0x00, 0x74, 0x00, 0x77, 0x00, 0x6f, 0x00, 0x72, 0x00, 0x6b, 0x00, 0x20, 0x00, 0x41, 0x00,
        0x6e, 0x00, 0x61, 0x00, 0x6c, 0x00, 0x79, 0x00, 0x7a, 0x00, 0x65, 0x00, 0x72, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xee, 0x02, 0x00, 0x00, 0x26, 0x02, 0x00, 0x00, 0x21, 0x02, 0x00, 0x00, 0x14, 0x00,
        0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xee, 0x02, 0x00, 0x00,
        0x26, 0x02, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xee, 0x02, 0x26, 0x02, 0x14, 0x00, 0x00, 0x00,
        0x14, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xee, 0x02, 0x26, 0x02,
    ];

    fn order_bytes(fields_present: u32, fields: &[u8]) -> Vec<u8> {
        let size = u16::try_from(ALTERNATE_SECONDARY_HEADER_SIZE + ORDER_FLAGS_SIZE + fields.len()).unwrap();
        let mut order = vec![WINDOWING_ORDER_CONTROL_FLAGS];
        order.extend_from_slice(&size.to_le_bytes());
        order.extend_from_slice(&fields_present.to_le_bytes());
        order.extend_from_slice(fields);
        order
    }

    fn le(values: &[u32]) -> Vec<u8> {
        values.iter().flat_map(|value| value.to_le_bytes()).collect()
    }

    fn decode_one(order: &[u8]) -> DecodedWindowingOrder {
        decode_windowing_order(&mut ReadCursor::new(order)).unwrap()
    }

    fn full_rect(width: u16, height: u16) -> Vec<WindowRectangle> {
        vec![WindowRectangle {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        }]
    }

    fn desktop_order() -> Vec<u8> {
        let mut fields = le(&[0x0140_0007]);
        fields.push(2);
        fields.extend(le(&[0x0140_0007, 0x0160_0024]));
        order_bytes(
            DESKTOP_TYPE | DESKTOP_HOOKED | DESKTOP_ACTIVE_WINDOW | DESKTOP_ZORDER,
            &fields,
        )
    }

    #[test]
    fn decodes_xrdp_new_window_order() {
        let DecodedWindowingOrder::Window(window) = decode_one(&XRDP_NEW_WINDOW_ORDER) else {
            panic!("expected a window order");
        };

        assert_eq!(
            window,
            WindowInfoOrder {
                window_id: 0x0140_0007,
                is_new: true,
                owner_window_id: Some(0x221),
                styles: Some(WindowStyles {
                    style: 0x00CF_0000,
                    extended_style: 0x0004_0000,
                }),
                show_state: Some(WindowShowState::Shown),
                title: Some("The Wireshark Network Analyzer".to_owned()),
                client_offset: Some(WindowPoint::default()),
                client_area_size: Some(WindowExtent {
                    width: 750,
                    height: 550
                }),
                root_parent: Some(0x221),
                window_offset: Some(WindowPoint { x: 20, y: 20 }),
                client_delta: Some(WindowPoint::default()),
                window_size: Some(WindowExtent {
                    width: 750,
                    height: 550
                }),
                window_rects: Some(full_rect(750, 550)),
                visible_offset: Some(WindowPoint { x: 20, y: 20 }),
                visibility_rects: Some(full_rect(750, 550)),
                ..WindowInfoOrder::default()
            }
        );
        let update = [[1, 0].as_slice(), &XRDP_NEW_WINDOW_ORDER].concat();
        let validated = try_decode_fast_path_windowing_orders(&mut ReadCursor::new(&update)).unwrap();
        assert!(validated.orders[0].requires_extended_support());
        assert_eq!(
            validated.orders[0].decode_typed().unwrap(),
            decode_one(&XRDP_NEW_WINDOW_ORDER)
        );
    }

    /// A geometry-only update; xrdp 0.10 never sends one (its configure path is disabled), other
    /// servers do.
    #[test]
    fn decodes_window_geometry_update_order() {
        let minus_eight = u32::from_le_bytes((-8i32).to_le_bytes());
        let mut fields = le(&[0x0140_0007, 0, 0, 640, 480, 0x221, minus_eight, 30, 0, 0, 640, 480]);
        fields.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0x80, 0x02, 0xe0, 0x01]);
        fields.extend(le(&[minus_eight, 30]));
        fields.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0x80, 0x02, 0xe0, 0x01]);
        let flags = WINDOW_TYPE
            | FIELD_CLIENT_AREA_OFFSET
            | FIELD_CLIENT_AREA_SIZE
            | FIELD_ROOT_PARENT
            | FIELD_WND_OFFSET
            | FIELD_WND_CLIENT_DELTA
            | FIELD_WND_SIZE
            | FIELD_WND_RECTS
            | FIELD_VIS_OFFSET
            | FIELD_VISIBILITY;
        let order = order_bytes(flags, &fields);

        let DecodedWindowingOrder::Window(window) = decode_one(&order) else {
            panic!("expected a window order");
        };
        assert!(!window.is_new);
        assert_eq!(window.title, None);
        assert_eq!(window.styles, None);
        assert_eq!(window.show_state, None);
        assert_eq!(window.window_offset, Some(WindowPoint { x: -8, y: 30 }));
        assert_eq!(
            window.window_size,
            Some(WindowExtent {
                width: 640,
                height: 480
            })
        );
        assert_eq!(window.visibility_rects, Some(full_rect(640, 480)));
    }

    #[test]
    fn decodes_show_and_deleted_orders() {
        let show = order_bytes(WINDOW_TYPE | FIELD_SHOW, &[7, 0, 0, 0, 2]);
        assert_eq!(
            decode_one(&show),
            DecodedWindowingOrder::Window(WindowInfoOrder {
                window_id: 7,
                show_state: Some(WindowShowState::Minimized),
                ..WindowInfoOrder::default()
            })
        );
        assert_eq!(
            decode_one(&order_bytes(WINDOW_TYPE | STATE_DELETED, &le(&[7]))),
            DecodedWindowingOrder::WindowDeleted { window_id: 7 }
        );
        let invalid_show = order_bytes(WINDOW_TYPE | FIELD_SHOW, &[7, 0, 0, 0, 4]);
        assert!(decode_windowing_order(&mut ReadCursor::new(&invalid_show)).is_err());
    }

    #[test]
    fn typed_decoder_agrees_with_validator_on_truncation() {
        for order in [XRDP_NEW_WINDOW_ORDER.to_vec(), desktop_order()] {
            for length in 0..order.len() {
                let mut truncated = order[..length].to_vec();
                if length >= ALTERNATE_SECONDARY_HEADER_SIZE {
                    truncated[1..3].copy_from_slice(&u16::try_from(length).unwrap().to_le_bytes());
                }
                let validated = WindowingOrder::decode(&mut ReadCursor::new(&truncated)).is_ok();
                let typed = decode_windowing_order(&mut ReadCursor::new(&truncated)).is_ok();
                assert_eq!(validated, typed, "length {length}");
                assert!(!typed, "a {length}-byte prefix must not decode");
            }
            assert!(decode_windowing_order(&mut ReadCursor::new(&order)).is_ok());
        }
    }

    #[test]
    fn long_titles_are_accepted_and_truncated() {
        let DecodedWindowingOrder::Window(mut window) = decode_one(&XRDP_NEW_WINDOW_ORDER) else {
            panic!("expected a window order");
        };
        window.title = Some(format!("{}\u{1F600}tail", "x".repeat(MAX_TITLE_CODE_UNITS - 1)));
        let forwarded = encode_forwarded_windowing_orders(&[DecodedWindowingOrder::Window(window)]).unwrap();

        let validated = try_decode_slow_path_windowing_orders(&mut ReadCursor::new(&forwarded[2..])).unwrap();
        assert_eq!(validated.orders.len(), 1);
        let decoded = decode_forwarded_windowing_orders(&forwarded).unwrap();
        let [DecodedWindowingOrder::Window(decoded)] = decoded.as_slice() else {
            panic!("expected one window order");
        };
        assert_eq!(
            decoded.title.as_deref().unwrap(),
            "x".repeat(MAX_TITLE_CODE_UNITS - 1),
            "a surrogate pair is never split"
        );
        assert_eq!(truncate_utf16("short".to_owned(), MAX_TITLE_CODE_UNITS), "short");
    }

    #[test]
    fn long_title_keeps_the_following_fields() {
        let DecodedWindowingOrder::Window(mut order) = decode_one(&XRDP_NEW_WINDOW_ORDER) else {
            panic!("expected a window order");
        };
        order.title = Some("y".repeat(700));
        let forwarded = encode_forwarded_windowing_orders(&[DecodedWindowingOrder::Window(order.clone())]).unwrap();

        let validated = try_decode_slow_path_windowing_orders(&mut ReadCursor::new(&forwarded[2..])).unwrap();
        assert!(!validated.contains_non_window_orders);
        order.title = Some("y".repeat(MAX_TITLE_CODE_UNITS));
        assert_eq!(
            decode_forwarded_windowing_orders(&forwarded).unwrap(),
            [DecodedWindowingOrder::Window(order)]
        );
    }

    #[test]
    fn odd_title_length_is_rejected_by_both_decoders() {
        let mut fields = 7u32.to_le_bytes().to_vec();
        fields.extend_from_slice(&3u16.to_le_bytes());
        fields.extend_from_slice(&[0x41, 0, 0]);
        let order = order_bytes(WINDOW_TYPE | FIELD_TITLE, &fields);

        assert!(WindowingOrder::decode(&mut ReadCursor::new(&order)).is_err());
        assert!(decode_windowing_order(&mut ReadCursor::new(&order)).is_err());
    }

    #[test]
    fn decodes_desktop_active_window_and_zorder() {
        assert_eq!(
            decode_one(&desktop_order()),
            DecodedWindowingOrder::Desktop(DesktopInfoOrder {
                hooked: true,
                active_window_id: Some(0x0140_0007),
                z_order: Some(vec![0x0140_0007, 0x0160_0024]),
                ..DesktopInfoOrder::default()
            })
        );
        assert_eq!(
            decode_one(&order_bytes(DESKTOP_TYPE | DESKTOP_NONE, &[])),
            DecodedWindowingOrder::Desktop(DesktopInfoOrder {
                non_monitored: true,
                ..DesktopInfoOrder::default()
            })
        );
    }

    #[test]
    fn forwarded_payload_round_trip() {
        let DecodedWindowingOrder::Window(mut window) = decode_one(&XRDP_NEW_WINDOW_ORDER) else {
            panic!("expected a window order");
        };
        window.overlay_description = Some("\u{e9}t\u{e9}".to_owned());
        window.horizontal_resize_margins = Some(WindowResizeMargins { start: 4, end: 5 });
        window.vertical_resize_margins = Some(WindowResizeMargins { start: 6, end: 7 });
        window.rp_content = Some(true);
        window.taskbar_button = Some(1);
        window.enforce_server_z_order = Some(1);
        window.app_bar_state = Some(2);
        window.app_bar_edge = Some(3);
        let orders = vec![
            DecodedWindowingOrder::Window(window),
            DecodedWindowingOrder::WindowDeleted { window_id: 0x0160_0024 },
            DecodedWindowingOrder::Desktop(DesktopInfoOrder {
                active_window_id: Some(0x0140_0007),
                hooked: true,
                ..DesktopInfoOrder::default()
            }),
        ];

        let forwarded = encode_forwarded_windowing_orders(&orders).unwrap();
        assert_eq!(forwarded[..8], [0, 0, 0, 0, 3, 0, 0, 0]);
        assert_eq!(decode_forwarded_windowing_orders(&forwarded).unwrap(), orders);

        let mut xrdp = vec![0, 0, 0, 0, 1, 0, 0, 0];
        xrdp.extend_from_slice(&XRDP_NEW_WINDOW_ORDER);
        let decoded = decode_forwarded_windowing_orders(&xrdp).unwrap();
        assert_eq!(encode_forwarded_windowing_orders(&decoded).unwrap(), xrdp);

        assert!(decode_forwarded_windowing_orders(&[1, 0, 0, 0, 0, 0, 0, 0]).is_err());
        let icon = DecodedWindowingOrder::WindowIcon {
            window_id: 1,
            cached: true,
        };
        assert!(encode_forwarded_windowing_orders(&[icon]).is_err());
    }
}
