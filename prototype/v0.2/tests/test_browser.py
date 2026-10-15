import asyncio, threading, http.server, socketserver, base64
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
STUB=(ROOT/'tests/mock_three.mjs').read_text()
PORT=8769
MOCK_URL='data:text/javascript;base64,'+base64.b64encode(STUB.encode()).decode()
HTML=(ROOT/'SIGNAL_ZERO_3D.html').read_text().replace('https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js',MOCK_URL)
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self, fmt,*args): pass
class Server(socketserver.TCPServer): allow_reuse_address=True
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
  desktop=await browser.new_context(viewport={'width':1450,'height':900},device_scale_factor=1)
  page=await desktop.new_page();errors=[]
  page.on('pageerror',lambda e: errors.append(str(e)))
  # Mock import is a self-contained data URL; no network use.
  await page.set_content(HTML,wait_until='load')
  await page.wait_for_function('Boolean(window.__SIGNAL_ZERO_TEST__)', timeout=5000)
  print('loaded mocked game. start text:',await page.locator('#start h1').inner_text())
  await page.locator('#start-new').click()
  assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==0
  # Simulated walk up to rack through world interaction and actual patch UI.
  await page.evaluate("window.__SIGNAL_ZERO_TEST__.setPosition(-6.4,5.0)")
  await page.locator('#touch-use').evaluate('(b)=>b.click()')
  assert not await page.locator('#patch').evaluate('(x)=>x.classList.contains("hidden")')
  await page.locator('[data-port="gw-lan1"]').click();await page.locator('[data-port="sw-uplink"]').click()
  await page.locator('#patch-submit').click()
  assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==1
  await page.locator('#close-patch').click()
  # Device computer UI plus real entered commands.
  async def cmd(host, val):
   await page.evaluate('(host)=>window.__SIGNAL_ZERO_TEST__.openStation(host)',host)
   await page.locator('#cmd').fill(val)
   await page.locator('#exec').click()
   out=await page.locator('#terminalout').inner_text()
   await page.locator('#close-desktop').click()
   return out
  txt=await cmd('client','ipconfig /all');assert '169.254.17.44' in txt
  txt=await cmd('server','dhcp start');assert 'DHCP service started' in txt
  await cmd('client','ipconfig /renew');assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==2
  await cmd('server','dns set clinic.ops.example 10.42.1.20');assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==2
  await cmd('client','ping clinic.ops.example');assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==2
  await cmd('client','curl https://clinic.ops.example/health');assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==3
  await cmd('switch','switch port 6 vlan 30');await cmd('router','firewall deny guest clinic')
  assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==3
  await cmd('router','audit guest');assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==4
  await cmd('router','route set default 10.42.0.254');await cmd('client','tracert 203.0.113.20')
  assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==4
  await cmd('client','curl https://backup.example.net/health')
  assert await page.evaluate('window.__SIGNAL_ZERO_TEST__.getStage()')==5
  assert 'CITY BACK ONLINE' in await page.locator('#mission-title').inner_text()
  await page.locator('#open-map').click();assert not await page.locator('#map-overlay').evaluate('(x)=>x.classList.contains("hidden")')
  assert await page.locator('#big-map svg').count()==1
  await page.screenshot(path=str(ROOT/'tests/desktop_terminal_mock.png'))
  await page.locator('#close-map').click()
  assert errors==[],errors
  print('DESKTOP UI PASS: 5 missions, path through patch UI, commands, map, no page errors')
  mobile=await browser.new_context(viewport={'width':430,'height':932},device_scale_factor=1,is_mobile=True,has_touch=True)
  p2=await mobile.new_page();errs2=[]
  p2.on('pageerror',lambda e:errs2.append(str(e)))
  # Mobile uses same mocked local module.
  await p2.set_content(HTML,wait_until='load');await p2.wait_for_function('Boolean(window.__SIGNAL_ZERO_TEST__)')
  await p2.locator('#start-new').click()
  await p2.evaluate("window.__SIGNAL_ZERO_TEST__.openStation('client')")
  assert await p2.locator('#cmd').is_visible()
  await p2.locator('#cmd').fill('ipconfig /all');await p2.locator('#exec').click()
  assert '[disconnected]' in await p2.locator('#terminalout').inner_text()
  await p2.screenshot(path=str(ROOT/'tests/mobile_terminal_mock.png'))
  assert errs2==[],errs2
  print('MOBILE UI PASS: opens workstation, shows command results, no page errors')
  await browser.close()
if __name__=='__main__':
 import os
 os.chdir(ROOT)
 with Server(('',PORT),Handler) as server:
  thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:asyncio.run(main())
  finally:server.shutdown()
