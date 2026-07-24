use iron_remote_desktop::RotationUnit;
use ironrdp::input::{MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use smallvec::SmallVec;
use tracing::warn;

#[derive(Clone)]
pub(crate) struct DeviceEvent(Operation);

/// Remap the left/right Meta ("Windows"/Command/Super) scancodes to Left Control.
///
/// On macOS the Command key is the primary shortcut modifier, but the trainee
/// desktop is Linux, where shortcuts use Control. Sending Meta as Left Control
/// lets Cmd+C / Cmd+V / Cmd+A behave like the host OS's command key. Regular
/// typing is unaffected: it flows through the Unicode path, not scancodes.
fn meta_to_ctrl(scancode: u16) -> u16 {
    const META_LEFT: u16 = 0xE05B;
    const META_RIGHT: u16 = 0xE05C;
    const CONTROL_LEFT: u16 = 0x001D;
    match scancode {
        META_LEFT | META_RIGHT => CONTROL_LEFT,
        other => other,
    }
}

impl iron_remote_desktop::DeviceEvent for DeviceEvent {
    fn mouse_button_pressed(button: u8) -> Self {
        match MouseButton::from_web_button(button) {
            Some(button) => Self(Operation::MouseButtonPressed(button)),
            None => {
                warn!("Unknown mouse button ID: {button}");
                Self(Operation::MouseButtonPressed(MouseButton::Left))
            }
        }
    }

    fn mouse_button_released(button: u8) -> Self {
        match MouseButton::from_web_button(button) {
            Some(button) => Self(Operation::MouseButtonReleased(button)),
            None => {
                warn!("Unknown mouse button ID: {button}");
                Self(Operation::MouseButtonReleased(MouseButton::Left))
            }
        }
    }

    fn mouse_move(x: u16, y: u16) -> Self {
        Self(Operation::MouseMove(MousePosition { x, y }))
    }

    fn wheel_rotations(vertical: bool, rotation_amount: i16, rotation_unit: RotationUnit) -> Self {
        const LINES_TO_PIXELS_SCALE: i16 = 50;
        const PAGES_TO_LINES_SCALE: i16 = 38;

        let lines_to_pixels = |lines: i16| lines * LINES_TO_PIXELS_SCALE;

        let pages_to_pixels = |pages: i16| pages * PAGES_TO_LINES_SCALE * LINES_TO_PIXELS_SCALE;

        let rotation_amount = match rotation_unit {
            RotationUnit::Pixel => rotation_amount,
            RotationUnit::Line => lines_to_pixels(rotation_amount),
            RotationUnit::Page => pages_to_pixels(rotation_amount),
        };

        Self(Operation::WheelRotations(WheelRotations {
            is_vertical: vertical,
            rotation_units: rotation_amount,
        }))
    }

    fn key_pressed(scancode: u16) -> Self {
        Self(Operation::KeyPressed(Scancode::from_u16(meta_to_ctrl(scancode))))
    }

    fn key_released(scancode: u16) -> Self {
        Self(Operation::KeyReleased(Scancode::from_u16(meta_to_ctrl(scancode))))
    }

    fn unicode_pressed(unicode: char) -> Self {
        Self(Operation::UnicodeKeyPressed(unicode))
    }

    fn unicode_released(unicode: char) -> Self {
        Self(Operation::UnicodeKeyReleased(unicode))
    }
}

pub(crate) struct InputTransaction(SmallVec<[Operation; 3]>);

impl iron_remote_desktop::InputTransaction for InputTransaction {
    type DeviceEvent = DeviceEvent;

    fn create() -> Self {
        Self(SmallVec::new())
    }

    fn add_event(&mut self, event: Self::DeviceEvent) {
        self.0.push(event.0);
    }
}

impl IntoIterator for InputTransaction {
    type IntoIter = smallvec::IntoIter<[Operation; 3]>;
    type Item = Operation;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}
