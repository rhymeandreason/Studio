// Board presets for the Enclosure tool. Units: mm. Origin = the board's
// bottom-left corner seen from above, with the "front" edge along y = 0
// (Raspberry Pi: the USB-C / HDMI edge; the GPIO header runs along the back).
//
// Port fields:
//   edge      front | back | left | right (a side wall) or top (the lid)
//   at        centre along the edge (x for front/back, y for left/right)
//   x, y      centre on the board, for edge "top"
//   z         bottom of the connector above the board's TOP surface
//             (negative = under the board, e.g. an underside microSD slot)
//   w, h      connector width along the edge × height (for top: x-size × y-size)
//   height    for edge "top": how tall the part stands above the board
//   overhang  how far the connector sticks out past the board edge
//   shape     "rect" (default) or "circle" (h is the diameter)
//   off       true = no cutout until ticked (GPIO, camera…)
//
// Numbers are taken from the vendors' mechanical drawings where available
// and rounded; measure your board before printing anything that must fit
// tightly, and nudge the cutouts in the tool.

export const BOARDS = {
  pi5: {
    name: "Raspberry Pi 5",
    w: 85, d: 56, t: 1.4, r: 3, holeDia: 2.7,
    holes: [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]],
    ports: [
      { id: "usbc", label: "USB-C power", edge: "front", at: 11.2, z: 0, w: 9, h: 3.3, overhang: 1.2 },
      { id: "hdmi0", label: "micro HDMI 0", edge: "front", at: 25.8, z: 0, w: 7.2, h: 3.6, overhang: 1.2 },
      { id: "hdmi1", label: "micro HDMI 1", edge: "front", at: 39.2, z: 0, w: 7.2, h: 3.6, overhang: 1.2 },
      { id: "usb-a", label: "USB 2.0", edge: "right", at: 9, z: 0, w: 13.5, h: 16, overhang: 2.3 },
      { id: "usb-b", label: "USB 3.0", edge: "right", at: 27, z: 0, w: 13.5, h: 16, overhang: 2.3 },
      { id: "eth", label: "Ethernet", edge: "right", at: 45.75, z: 0, w: 16, h: 13.5, overhang: 2.6 },
      { id: "sd", label: "microSD", edge: "left", at: 28, z: -2.9, w: 12, h: 1.5, overhang: 0 },
      { id: "gpio", label: "GPIO header", edge: "top", x: 32.5, y: 52.5, w: 51, h: 5.1, height: 8.5, off: true },
    ],
  },
  pi4: {
    name: "Raspberry Pi 4 B",
    w: 85, d: 56, t: 1.4, r: 3, holeDia: 2.7,
    holes: [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]],
    ports: [
      { id: "usbc", label: "USB-C power", edge: "front", at: 11.2, z: 0, w: 9, h: 3.3, overhang: 1.2 },
      { id: "hdmi0", label: "micro HDMI 0", edge: "front", at: 26, z: 0, w: 7.2, h: 3.6, overhang: 1.2 },
      { id: "hdmi1", label: "micro HDMI 1", edge: "front", at: 39.5, z: 0, w: 7.2, h: 3.6, overhang: 1.2 },
      { id: "audio", label: "Audio", edge: "front", at: 53.5, z: 0, w: 6, h: 6, overhang: 2.5, shape: "circle" },
      { id: "eth", label: "Ethernet", edge: "right", at: 10.25, z: 0, w: 16, h: 13.5, overhang: 2.6 },
      { id: "usb-a", label: "USB 2.0", edge: "right", at: 29, z: 0, w: 13.5, h: 16, overhang: 2.3 },
      { id: "usb-b", label: "USB 3.0", edge: "right", at: 47, z: 0, w: 13.5, h: 16, overhang: 2.3 },
      { id: "sd", label: "microSD", edge: "left", at: 28, z: -2.9, w: 12, h: 1.5, overhang: 0 },
      { id: "gpio", label: "GPIO header", edge: "top", x: 32.5, y: 52.5, w: 51, h: 5.1, height: 8.5, off: true },
    ],
  },
  zero2w: {
    name: "Raspberry Pi Zero 2 W",
    w: 65, d: 30, t: 1.2, r: 3, holeDia: 2.75,
    holes: [[3.5, 3.5], [61.5, 3.5], [3.5, 26.5], [61.5, 26.5]],
    ports: [
      { id: "hdmi", label: "mini HDMI", edge: "front", at: 12.4, z: 0, w: 11.4, h: 3.6, overhang: 0.5 },
      { id: "usb", label: "micro USB", edge: "front", at: 41.4, z: 0, w: 8, h: 3, overhang: 1 },
      { id: "pwr", label: "micro USB power", edge: "front", at: 54, z: 0, w: 8, h: 3, overhang: 1 },
      { id: "sd", label: "microSD", edge: "left", at: 16.9, z: 0, w: 12, h: 1.6, overhang: 1.5 },
      { id: "csi", label: "Camera", edge: "right", at: 15, z: 0, w: 17, h: 1.5, overhang: 0, off: true },
      { id: "gpio", label: "GPIO header", edge: "top", x: 32.5, y: 26.5, w: 51, h: 5.1, height: 8.5, off: true },
    ],
  },
  uno: {
    name: "Arduino Uno R3",
    w: 68.6, d: 53.3, t: 1.6, r: 1, holeDia: 3.2,
    holes: [[14, 2.5], [15.3, 50.7], [66.1, 7.6], [66.1, 35.5]],
    ports: [
      { id: "usb", label: "USB-B", edge: "left", at: 38.1, z: 0, w: 12, h: 10.9, overhang: 6.2 },
      { id: "dc", label: "DC jack", edge: "left", at: 7.6, z: 0, w: 9, h: 11, overhang: 1.8 },
    ],
  },
};

export const BOARD_ORDER = ["pi5", "pi4", "zero2w", "uno", "custom"];
