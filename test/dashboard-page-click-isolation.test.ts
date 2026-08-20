import { describe, expect, it } from 'vitest';

import { DASHBOARD_HTML } from '../src/dashboard/dashboard-page.js';

/**
 * Guards the click contract between a task card and the controls drawn inside
 * it. The card itself is clickable (it opens the detail panel), so every control
 * nested in it must claim its own click.
 *
 * Two shipped regressions motivate these assertions:
 *
 *  1. `onTaskClick` decided whether a click belonged to a control by walking
 *     `event.target.closest('button, a, input')`. The removal handler rewrote
 *     its own button label, which detached the clicked icon node; `closest()`
 *     on a detached node returns null, so the guard passed and the detail panel
 *     opened behind an in-flight removal.
 *  2. The select checkbox is a visually hidden `input` behind a drawn box, so
 *     the actual click target was a `span`/`svg` that matched no selector in
 *     that guard, and ticking the box also opened the detail panel.
 *
 * The fix is structural: controls call `stopPropagation`, and busy state never
 * rewrites a button's children. These tests assert the source keeps that shape,
 * because both failures are invisible to API-level tests.
 */
describe('dashboard task card click isolation', () => {
  const script = DASHBOARD_HTML;

  it('opens the detail panel without inspecting the click target', () => {
    const fn = /function onTaskClick\([\s\S]*?\n}/.exec(script);
    expect(fn).not.toBeNull();
    // Strip comments first: the fix is documented in prose that names the very
    // API being banned, so only executable lines are asserted on.
    const code = fn![0]
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // A target-sniffing guard is exactly what broke: a detached node reports no
    // ancestors, so the card handler ran during removal.
    expect(code).not.toMatch(/closest\(/);
    expect(code).toMatch(/openDetail\(runId\)/);
  });

  it('stops propagation on every control drawn inside a card', () => {
    // Card removal button: the icon inside it is the usual click target.
    expect(script).toMatch(/class="card-del"[\s\S]{0,200}?event\.stopPropagation\(\)/);
    // Select checkbox: both the label and the input, because a label click
    // re-dispatches to the input and that second event bubbles on its own.
    expect(script).toMatch(/class="pick"[\s\S]{0,200}?onclick="event\.stopPropagation\(\)"/);
    expect(script).toMatch(/type="checkbox"[\s\S]{0,200}?event\.stopPropagation\(\);toggleSelect/);
  });

  it('never rewrites a delete button label while it is busy', () => {
    const fn = /async function deleteRuns\([\s\S]*?\n}/.exec(script);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // Writing textContent would drop the icon child and detach the click target.
    expect(body).not.toMatch(/btn\.textContent\s*=/);
    expect(body).toMatch(/setAttribute\('data-busy'/);
    expect(body).toMatch(/removeAttribute\('data-busy'\)/);
  });

  it('renders a busy label from CSS so icon-only buttons keep their glyph', () => {
    expect(script).toMatch(/\[data-busy\]::after\{content:'Removing…'\}/);
  });

  it('keeps the detail-panel remove label in a span so CSS can swap it', () => {
    expect(script).toMatch(/class="task-del"[\s\S]{0,160}?<span>Remove from board<\/span>/);
  });
});
