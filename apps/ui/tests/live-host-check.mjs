import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from "@playwright/test";
import { browserLaunchOptions } from "./browser-options.mjs";
// Explicit opt-in. This exercises the real authenticated host and creates one empty chat.
if(process.env.MARS_LIVE_HOST_CHECK!=='1') throw Error('Set MARS_LIVE_HOST_CHECK=1 to verify an existing configured host');
const root=process.env.MARS_PI_ROOT||join(process.env.XDG_DATA_HOME||join(homedir(),'.local/share'),'mars');
const token=process.env.MARS_PI_TOKEN||(await readFile(process.env.MARS_PI_TOKEN_FILE||join(root,'data/web-token'),'utf8')).trim();
const origin=process.env.MARS_PI_ORIGIN||`http://127.0.0.1:${process.env.MARS_PI_PORT||'3081'}`;
const evidence=process.env.MARS_EVIDENCE_DIR||'test-results/live-host';await mkdir(evidence,{recursive:true});
const browser = await chromium.launch(browserLaunchOptions());
try {
 const ctx=await browser.newContext({viewport:{width:1280,height:900}});await ctx.addCookies([{name:'pi_trial',value:token,url:origin}]);const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin,{waitUntil:'domcontentloaded',timeout:120000});
 await page.getByRole('button',{name:'Main conversation',exact:true}).waitFor();
 await page.getByRole('button',{name:'New chat',exact:true}).click();
 await page.getByRole('heading',{name:'What shall we work on?'}).waitFor();
 await page.getByRole('button',{name:'Main conversation',exact:true}).click();
 await page.getByRole('button',{name:/^Extensions/}).click();
 const card=page.locator('.live-plugin-card').filter({has:page.getByRole('heading',{name:'Mock Discord',exact:true})});
 const catalogue=await ctx.request.get(new URL('/api/plugins',origin).href);const mock=(await catalogue.json()).plugins.find(plugin=>plugin.name==='mock-discord');assert.ok(mock);
 const open=card.getByRole('button',{name:'Open interface',exact:true});
 if(mock.enabled&&mock.uiEnabled){await open.click();const extension=page.getByRole('region',{name:'Mock Discord',exact:true});await extension.waitFor();await extension.getByText('MARS_DSH_DISCORD_V1',{exact:false}).waitFor();}
 else assert.equal(await open.isDisabled(),true,'respect existing owner-disabled interface');
 await page.getByRole('button',{name:'Open settings',exact:true}).click();
 await page.getByRole('button',{name:'Reconnect Claude',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Appearance'}).click();await page.getByRole('button',{name:/^OLED\b/}).waitFor();
 await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);
 await page.screenshot({path:evidence+'/live-host.png'});
 console.log('PASS actual owner authentication, native new chat/switch, installed Mock Discord interface preference, connected Claude controls, OLED and no browser exceptions');
} finally {await browser.close();}
