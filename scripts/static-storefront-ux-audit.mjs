import fs from 'node:fs';

const html = fs.readFileSync('public/store/index.html', 'utf8');
const css = fs.readFileSync('public/store/styles.css', 'utf8');
const js = fs.readFileSync('public/store/app.js', 'utf8');

const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
};

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

check('no duplicate storefront HTML ids', duplicates.length === 0);
check('desktop + mobile currency selectors are wired', html.includes('id="currencySelector" data-currency-selector') && html.includes('id="mobileCurrencySelector" data-currency-selector'));
check('desktop + mobile language selectors are wired', html.includes('id="languageSelector" data-language-selector') && html.includes('id="mobileLanguageSelector" data-language-selector'));
check('search/menu buttons expose expanded state', html.includes('id="searchToggle"') && html.includes('aria-expanded="false"') && html.includes('id="mobileMenuButton"'));
check('header has non-transparent baseline surface', css.includes('background:rgba(7,7,7,.94)') && css.includes('background:rgba(245,241,232,.95)'));
check('desktop header collision breakpoint exists', css.includes('@media(max-width:1320px)') && css.includes('.desktop-nav{display:none}'));
check('long page titles wrap safely', css.includes('overflow-wrap:anywhere') && css.includes('text-wrap:balance'));
check('mobile search has 44px target', css.includes('#searchToggle{display:grid;width:44px;height:44px'));
check('mobile region/language UI exists', css.includes('.mobile-localization-grid'));
check('automotive product imagery uses contain', css.includes('object-fit:contain'));
check('currency selectors synchronize in JS', js.includes("$$('[data-currency-selector]')"));
check('language selectors synchronize in JS', js.includes("$$('[data-language-selector]')"));
check('search aria-expanded state is synchronized', js.includes("$('#searchToggle')?.setAttribute('aria-expanded','false')") && js.includes("$('#searchToggle')?.setAttribute('aria-expanded','true')"));
check('mobile-menu aria-expanded state is synchronized', js.includes("$('#mobileMenuButton')?.setAttribute('aria-expanded','false')") && js.includes("$('#mobileMenuButton')?.setAttribute('aria-expanded','true')"));
check('Escape closes overlays', js.includes("if(e.key==='Escape')"));
check('clicking outside search closes it', js.includes("!e.target.closest('#searchPanel')"));
check('product image helper accepts multiple API shapes', js.includes("typeof first === 'string'") && js.includes('p?.imageUrl'));

let balance = 0;
for (const ch of css) {
  if (ch === '{') balance++;
  else if (ch === '}') balance--;
  if (balance < 0) break;
}
check('CSS braces are balanced', balance === 0);

const failed = checks.filter(x => !x.ok);
if (failed.length) {
  if (duplicates.length) console.error(`Duplicate ids: ${duplicates.join(', ')}`);
  console.error(`Storefront UX audit failed: ${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}
console.log(`SANDMAN storefront UX audit passed (${checks.length}/${checks.length}).`);
