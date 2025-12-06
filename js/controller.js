// NES Controller Input Handler
// Button order (bit 0 to bit 7): A, B, Select, Start, Up, Down, Left, Right

export class Controller {
    constructor(bus) {
        this.bus = bus;

        // Key mappings for Player 1
        // Bit positions match NES serial read order (A first = bit 0)
        this.keyMap = {
            'KeyZ': 0,        // A      (bit 0)
            'KeyX': 1,        // B      (bit 1)
            'ShiftRight': 2,  // Select (bit 2)
            'ShiftLeft': 2,   // Select (bit 2)
            'Enter': 3,       // Start  (bit 3)
            'ArrowUp': 4,     // Up     (bit 4)
            'ArrowDown': 5,   // Down   (bit 5)
            'ArrowLeft': 6,   // Left   (bit 6)
            'ArrowRight': 7   // Right  (bit 7)
        };

        this.buttons = 0;
        this.setupListeners();
    }

    setupListeners() {
        document.addEventListener('keydown', (e) => {
            const bit = this.keyMap[e.code];
            if (bit !== undefined) {
                // Set bit directly (A = bit 0, Right = bit 7)
                this.buttons |= (1 << bit);
                e.preventDefault();
            }
        });

        document.addEventListener('keyup', (e) => {
            const bit = this.keyMap[e.code];
            if (bit !== undefined) {
                this.buttons &= ~(1 << bit);
                e.preventDefault();
            }
        });
    }

    update() {
        this.bus.controller[0] = this.buttons;
    }
}

