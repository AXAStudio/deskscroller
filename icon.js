// The app icon, drawn in code so the app ships without image assets.
// Used by main.js for the window / tray, and by build/make-icon.js for the installer.

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.26;
  const half = size / 2;
  const SS = 4;
  // Play triangle in unit coordinates.
  const tri = [[0.4, 0.3], [0.4, 0.7], [0.72, 0.5]];
  const inTri = (px, py) => {
    const [[ax, ay], [bx, by], [cx, cy]] = tri;
    const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
    const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let shape = 0, play = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          const dx = Math.max(Math.abs(px - half) - (half - r), 0);
          const dy = Math.max(Math.abs(py - half) - (half - r), 0);
          if (Math.hypot(dx, dy) <= r) {
            shape++;
            if (inTri(px / size, py / size)) play++;
          }
        }
      }
      const a = shape / (SS * SS);
      const w = shape ? play / shape : 0;
      // Diagonal gradient: hot pink -> violet.
      const t = (x + y) / (2 * size);
      let R = 255 + (124 - 255) * t, G = 61 + (77 - 61) * t, B = 110 + (255 - 110) * t;
      R += (255 - R) * w; G += (255 - G) * w; B += (255 - B) * w;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(B * a);
      buf[i + 1] = Math.round(G * a);
      buf[i + 2] = Math.round(R * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return buf;
}

module.exports = { drawIcon };
