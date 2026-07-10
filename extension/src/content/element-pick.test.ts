// ABOUTME: Unit tests for the element-picker helpers — CSS selector + XPath builders, the token-stability
// ABOUTME: heuristic, the React-props sanitizer, and the fiber reader. Pure vitest with fake element/fiber trees.
import { describe, it, expect } from 'vitest';
import { buildSelector, buildXPath, isStableToken, sanitizeProps, readReactInfo } from './element-pick';

// A minimal fake element that implements exactly the surface the pure builders read, with parent/sibling
// links wired so nth-of-type + path walks behave like the real DOM — no jsdom required.
type Fake = {
  nodeType: number;
  tagName: string;
  id?: string;
  className?: string;
  textContent?: string;
  parentElement: Fake | null;
  previousElementSibling: Fake | null;
  nextElementSibling: Fake | null;
};
function el(tag: string, opts: { id?: string; className?: string; text?: string } = {}, children: Fake[] = []): Fake {
  const node: Fake = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: opts.id,
    className: opts.className,
    textContent: opts.text,
    parentElement: null,
    previousElementSibling: null,
    nextElementSibling: null,
  };
  children.forEach((c, i) => {
    c.parentElement = node;
    c.previousElementSibling = i > 0 ? children[i - 1] : null;
    c.nextElementSibling = i < children.length - 1 ? children[i + 1] : null;
  });
  return node;
}

describe('isStableToken', () => {
  it('accepts human-readable class/id tokens', () => {
    expect(isStableToken('card')).toBe(true);
    expect(isStableToken('btn-primary')).toBe(true);
    expect(isStableToken('nav_item')).toBe(true);
  });
  it('rejects machine-generated tokens', () => {
    expect(isStableToken('css-1a2b3c')).toBe(false); // css-in-js prefix
    expect(isStableToken('sc-AxjAm')).toBe(false); // styled-components
    expect(isStableToken(':r3:')).toBe(false); // React useId
    expect(isStableToken('item-12345')).toBe(false); // long digit run
    expect(isStableToken('deadbeef99')).toBe(false); // hex hash
    expect(isStableToken('')).toBe(false);
  });
});

describe('buildSelector', () => {
  it('anchors on a stable id', () => {
    expect(buildSelector(el('div', { id: 'main' }))).toBe('#main');
  });
  it('adds :nth-of-type only when a same-tag sibling exists', () => {
    const li1 = el('li');
    const li2 = el('li');
    const li3 = el('li');
    const ul = el('ul', {}, [li1, li2, li3]);
    const body = el('body', {}, [ul]);
    el('html', {}, [body]);
    expect(buildSelector(li2)).toBe('body > ul > li:nth-of-type(2)');
  });
  it('includes stable classes and filters dynamic ones', () => {
    const btn = el('button', { className: 'btn btn-primary css-1a2b3c sc-XyZ' });
    const box = el('div', { className: 'card' }, [btn]);
    const body = el('body', {}, [box]);
    el('html', {}, [body]);
    expect(buildSelector(btn)).toBe('body > div.card > button.btn.btn-primary');
  });
  it('ignores a dynamic id and falls back to a path', () => {
    const d = el('div', { id: ':r7:' });
    const body = el('body', {}, [d]);
    el('html', {}, [body]);
    expect(buildSelector(d)).toBe('body > div');
  });
});

describe('buildXPath', () => {
  it('builds a positional path from html down', () => {
    const li1 = el('li');
    const li2 = el('li');
    const ul = el('ul', {}, [li1, li2]);
    const body = el('body', {}, [ul]);
    el('html', {}, [body]);
    expect(buildXPath(li2)).toBe('/html[1]/body[1]/ul[1]/li[2]');
  });
});

describe('sanitizeProps', () => {
  it('keeps primitives, stringifies functions, elides children', () => {
    const out = sanitizeProps({ title: 'Hi', count: 3, active: true, onClick: () => {}, children: 'x' });
    expect(out).toEqual({ title: 'Hi', count: 3, active: true, onClick: '[fn]', children: '[children]' });
  });
  it('notes DOM nodes and React elements instead of serializing them', () => {
    const out = sanitizeProps({
      node: { nodeType: 1, tagName: 'DIV' },
      element: { $$typeof: Symbol.for('react.element'), type: 'div' },
    });
    expect(out).toEqual({ node: '[node div]', element: '[element]' });
  });
  it('recurses one level into nested objects', () => {
    expect(sanitizeProps({ style: { color: 'red', width: 10 } })).toEqual({ style: { color: 'red', width: 10 } });
  });
  it('does not deep-walk beyond shallow depth', () => {
    expect(sanitizeProps({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: '[object]' } } });
  });
  it('handles circular refs without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(sanitizeProps(a)).toEqual({ name: 'a', self: { name: 'a', self: '[circular]' } });
  });
  it('caps total serialized size and flags truncation', () => {
    const out = sanitizeProps({ big: 'x'.repeat(5000) }, 200);
    expect(out?.__truncated).toBe(true);
    expect(out?.big).toBeUndefined();
  });
  it('returns undefined for a non-object', () => {
    expect(sanitizeProps(null)).toBeUndefined();
    expect(sanitizeProps('str')).toBeUndefined();
  });
});

describe('readReactInfo', () => {
  it('walks the fiber chain to the nearest component with sanitized props', () => {
    function Button() {}
    function Card() {}
    const cardFiber = { type: Card, memoizedProps: { title: 'Hi' }, return: null };
    const btnFiber = { type: Button, memoizedProps: { label: 'Go', onClick: () => {} }, return: cardFiber };
    const hostFiber = { type: 'button', memoizedProps: { className: 'x' }, return: btnFiber };
    const node: Record<string, unknown> = { nodeType: 1, tagName: 'BUTTON' };
    node['__reactFiber$abc'] = hostFiber;
    const info = readReactInfo(node);
    expect(info?.component).toBe('Button');
    expect(info?.props).toEqual({ label: 'Go', onClick: '[fn]' });
    expect(info?.chain).toEqual(['Button', 'Card']);
  });
  it('unwraps memo/forwardRef display names', () => {
    const memoType = { $$typeof: Symbol.for('react.memo'), type: { displayName: 'MemoInner' } };
    const fiber = { type: memoType, memoizedProps: {}, return: null };
    const node: Record<string, unknown> = { nodeType: 1, tagName: 'DIV' };
    node['__reactInternalInstance$xyz'] = fiber; // legacy React 16 key
    expect(readReactInfo(node)?.component).toBe('MemoInner');
  });
  it('returns undefined on a non-React node', () => {
    expect(readReactInfo({ nodeType: 1, tagName: 'DIV' })).toBeUndefined();
  });
});
