// Exercise both native sizes through actual pointer and keyboard input.
module.exports = async function checkbox({ cdp, check, selector, size }) {
  const read = () => cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const rect = input.getBoundingClientRect();
    const style = getComputedStyle(input), fill = getComputedStyle(input, '::after');
    return {
      checked: input.checked, width: rect.width, height: rect.height,
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      borderColor: style.borderColor, radius: style.borderRadius, background: style.backgroundColor,
      fill: fill.content, fillColor: fill.backgroundColor,
      inset: [fill.top, fill.right, fill.bottom, fill.left],
      fillWidth: parseFloat(fill.width), fillHeight: parseFloat(fill.height),
      labelled: input.labels.length > 0 || !!document.getElementById(input.getAttribute('aria-labelledby'))?.textContent.trim(),
      focused: input.matches(':focus-visible'), outline: style.outlineStyle, outlineWidth: style.outlineWidth,
    };
  })()`);
  const before = await read();
  await cdp.clickAt(selector);
  await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).checked === ${!before.checked}`);
  const after = await read();
  check(`${size}px checkbox keeps the same border box in both states`,
    before.width === size && before.height === size && after.width === size && after.height === size
      && before.borderColor === after.borderColor && before.radius === '3px' && after.radius === '3px'
      && [...before.borders, ...after.borders].every(width => width === '2px'), JSON.stringify({ before, after }));
  const on = before.checked ? before : after, off = before.checked ? after : before;
  check(`${size}px checked fill has a transparent 2px gap on every side`,
    on.fill !== 'none' && on.inset.every(inset => inset === '2px')
      && on.fillWidth === size - 8 && on.fillHeight === size - 8 && on.fillColor === on.borderColor
      && on.background === 'rgba(0, 0, 0, 0)' && off.background === 'rgba(0, 0, 0, 0)' && off.fill === 'none');
  await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp.keyTrusted(' ', { code: 'Space', vk: 32 });
  await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).checked === ${before.checked}`);
  const keyboard = await read();
  check(`${size}px native labelled checkbox toggles with Space and shows focus`,
    keyboard.labelled && keyboard.focused && keyboard.outline === 'solid' && keyboard.outlineWidth === '2px');
};
