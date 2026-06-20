import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of the structural parse in lib/pipeline/telegram-post.ts (T130).
// Covers the RELIABLE fields (photos, outbound links, maps link, hashtags, post id);
// the free-form body → place record is the claude -p step (not unit-tested here).
function stripTags(s) { return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(); }
function parse(html) {
  const tm = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>\s*<div class="tgme_widget_message_footer/.exec(html)
    || /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(html);
  const text = tm ? stripTags(tm[1]) : '';
  const photos = [];
  for (const m of html.matchAll(/background-image:url\('([^']+)'\)/g)) if (m[1].includes('telesco.pe') && !photos.includes(m[1])) photos.push(m[1]);
  const links = [];
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) { const u = m[1]; if (!/t\.me|telegram\./.test(u) && !links.includes(u)) links.push(u); }
  const maps_url = links.find((u) => /maps\.app\.goo\.gl|google\.[^/]+\/maps|goo\.gl\/maps/.test(u)) || null;
  const hashtags = [...new Set((text.match(/#([^\s#<]+)/g) || []).map((t) => t.slice(1)))];
  const idm = /t\.me\/[^/"']+\/(\d+)/.exec(html);
  return { post_id: idm ? Number(idm[1]) : null, text, photos, links, maps_url, hashtags };
}

const HTML = `
<div class="tgme_widget_message_text">Yume Ramen в La Eliana. 🍜 Меню: <a href="https://yume.es/shop">тут</a> #досуг #ramen</div>
<div class="tgme_widget_message_footer">footer</div>
<a class="photo" href="https://t.me/logunespa/1800" style="background-image:url('https://cdn4.telesco.pe/file/abc.jpg')"></a>
<i style="background-image:url('//telegram.org/img/emoji/40/F09F8D9C.png')"></i>
<a href="https://maps.app.goo.gl/xyz">map</a>`;

test('parseTelegramPost: structural fields', () => {
  const p = parse(HTML);
  assert.equal(p.post_id, 1800);
  assert.deepEqual(p.photos, ['https://cdn4.telesco.pe/file/abc.jpg'], 'real photo only, emoji excluded');
  assert.equal(p.maps_url, 'https://maps.app.goo.gl/xyz');
  assert.ok(p.links.includes('https://yume.es/shop'));
  assert.ok(!p.links.some((u) => u.includes('t.me')), 'telegram links excluded');
  assert.deepEqual(p.hashtags.sort(), ['ramen', 'досуг'].sort());
  assert.ok(p.text.includes('Yume Ramen'));
});
