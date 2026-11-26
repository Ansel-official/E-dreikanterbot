const devices = {
  desktop: { width: 1180, height: 820, label: 'Desktop · 1180 × 820' },
  tablet: { width: 820, height: 1000, label: 'Tablet · 820 × 1000' },
  mobile: { width: 390, height: 844, label: 'Mobile · 390 × 844' },
  small: { width: 360, height: 780, label: 'Small phone · 360 × 780' },
};

const key = new URLSearchParams(location.search).get('device') || 'desktop';
const device = devices[key] || devices.desktop;
const frame = document.getElementById('frame');
frame.style.width = `${device.width}px`;
frame.style.height = `${device.height}px`;
document.getElementById('label').textContent = device.label;
