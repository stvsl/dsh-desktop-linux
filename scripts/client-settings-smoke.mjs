/** TEST ONLY: prepended to a disposable bundle by smoke-client-settings.py. */
import * as smokeElectron from 'electron'
import * as smokeFs from 'node:fs/promises'
import { join as smokeJoin } from 'node:path'
const smokeDir = process.env.DSH_CLIENT_SMOKE_OUTPUT
const smokeDelay = ms => new Promise(resolve => setTimeout(resolve, ms))
let smokeTray
const smokeSetMenu = smokeElectron.Tray.prototype.setContextMenu
smokeElectron.Tray.prototype.setContextMenu = function (menu) { smokeTray = menu; return smokeSetMenu.call(this, menu) }
const smokeDialog = smokeElectron.dialog.showMessageBox
smokeElectron.dialog.showMessageBox = function (...args) {
  const options = args.at(-1)
  if (String(options.title).includes('重启') || String(options.title).toLowerCase().includes('restart')) return Promise.resolve({ response: 1, checkboxChecked: false })
  return smokeDialog.apply(this, args)
}
let smokeStarted = false
smokeElectron.app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', async () => {
    if (smokeStarted || !window.webContents.getURL().startsWith('dsh-app://app/')) return
    smokeStarted = true
    const assert = (ok, message) => { if (!ok) throw new Error(message); console.info('CLIENT_SMOKE PASS ' + message) }
    const until = async predicate => { for (let count = 0; count < 160; count++) { if (await predicate()) return; await smokeDelay(100) }; throw new Error('readiness timeout') }
    const page = script => window.webContents.executeJavaScript(script)
    try {
      await until(() => page("!!document.querySelector('dsh-kde-window-controls')"))
      const prefs = window.webContents.getLastWebPreferences()
      assert(prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration, 'main renderer sandbox preserved')
      const stageFile = smokeJoin(smokeDir, 'stage.json')
      let stage = 0
      try { stage = JSON.parse(await smokeFs.readFile(stageFile, 'utf8')).stage } catch (error) { if (error.code !== 'ENOENT') throw error }
      await until(() => page("!!document.querySelector('[data-window-drag]')"))
      const expectedGlass = stage < 2
      await until(async () => (await page("document.documentElement.hasAttribute('data-dsh-glass')")) === expectedGlass)
      assert((await page("document.documentElement.hasAttribute('data-dsh-glass')")) === expectedGlass, `stage ${stage} startup sidebar material`)
      await until(() => smokeTray?.items.some(item => /客户端设置|Client settings/u.test(item.label)))
      const item = smokeTray.items.find(item => /客户端设置|Client settings/u.test(item.label))
      item.click()
      await until(() => smokeElectron.BrowserWindow.getAllWindows().some(win => win.webContents.getURL().endsWith('/client-settings.html')))
      const settings = smokeElectron.BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/client-settings.html'))
      await until(() => settings.webContents.executeJavaScript("!document.getElementById('appearance-form').hidden"))
      const settingsPrefs = settings.webContents.getLastWebPreferences()
      assert(settingsPrefs.sandbox && settingsPrefs.contextIsolation && !settingsPrefs.nodeIntegration, 'settings renderer sandbox preserved')
      const evaluate = script => settings.webContents.executeJavaScript(script)
      const snapshot = await evaluate('window.dshClientSettings.get()')
      assert(snapshot.kind === 'ok', 'real isolated settings IPC returns snapshot')
      const expectedStyle = ['macos','windows','macos'][stage]
      assert(snapshot.value.current.titlebarStyle === expectedStyle, `stage ${stage} saved title-bar style reloaded`)
      assert((await page("document.documentElement.getAttribute('data-dsh-titlebar-style')")) === expectedStyle, `stage ${stage} real title-bar style applied`)
      assert(snapshot.value.defaults.sidebarOpacity === 80, 'default transparency is twenty percent')
      if (stage === 0) assert(snapshot.value.current.sidebarOpacity === 80, 'fresh startup uses twenty-percent transparency')
      const expectedRadius = [12,24,0][stage]
      assert(snapshot.value.current.cornerRadius === expectedRadius, `stage ${stage} saved radius reloaded`)
      const clipPath = await page('getComputedStyle(document.documentElement).clipPath')
      assert(clipPath.includes(`${expectedRadius}px`) || (expectedRadius === 0 && clipPath.includes('0px')), `stage ${stage} real renderer corner clipping applied`)
      assert(snapshot.value.current.systemShadow === (stage !== 1), `stage ${stage} saved system shadow reloaded`)
      const count = smokeElectron.BrowserWindow.getAllWindows().length
      item.click(); await smokeDelay(50)
      assert(smokeElectron.BrowserWindow.getAllWindows().length === count, 'tray settings window is singleton')
      if (expectedGlass) {
        const fade = await page(`(() => { const node=document.querySelector('[data-sidebar-scrollport] + span[aria-hidden="true"]'); return node && { display:getComputedStyle(node).display, oldSelector:node.matches('[class$="_fade"]'), className:node.className }; })()`)
        assert(fade && fade.display === 'none' && !fade.oldSelector, `stage ${stage} real sidebar scrollFade is hidden, not matched by obsolete selector`)
      }
      if (stage === 1) {
        const clickControl = async offset => {
          const box=await page(`(() => { const r=document.querySelector('dsh-kde-window-controls').getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width}; })()`)
          assert(box.x > 0 && box.width === 138, 'Windows controls occupy the right edge')
          const point={x:Math.round(box.x+offset),y:Math.round(box.y+24),button:'left',clickCount:1}
          window.webContents.sendInputEvent({type:'mouseDown',...point}); window.webContents.sendInputEvent({type:'mouseUp',...point})
        }
        window.show(); window.focus(); await smokeDelay(100)
        await clickControl(69); await until(() => window.isMaximized())
        assert(await page("document.documentElement.hasAttribute('data-kde-glass-maximized')"), 'trusted Windows maximize click reaches native window')
        await clickControl(69); await until(() => !window.isMaximized())
        await clickControl(23); await until(() => window.isMinimized())
        window.restore(); window.focus(); await until(() => !window.isMinimized())
        await smokeDelay(200)
        await smokeFs.writeFile(smokeJoin(smokeDir, 'titlebar-windows.png'), (await window.webContents.capturePage()).toPNG())
      }
      if (stage === 2) {
        await smokeFs.writeFile(smokeJoin(smokeDir, 'result.json'), JSON.stringify({ ok:true, stages:3, nativeWayland:true, sandbox:true, tray:true, restart:true, sidebarOpacity:true, shadowToggle:true, cornerRadius:true, titlebarStyle:true, sidebarFade:true, trustedWindowsControls:true },null,2)+'\n')
        settings.close()
        assert(!window.isDestroyed(), 'closing settings preserves primary window')
        console.info('CLIENT_SMOKE COMPLETE')
        smokeElectron.app.quit(); return
      }
      settings.show(); settings.setAlwaysOnTop(true); settings.focus()
      if (stage === 0) {
        await smokeDelay(300)
        await smokeFs.writeFile(smokeJoin(smokeDir, 'settings-window.png'), (await settings.webContents.capturePage()).toPNG())
        window.setAlwaysOnTop(true); window.show(); window.focus()
        await smokeDelay(300)
        const fadeBefore = await page(`(() => { const node=document.querySelector('[data-sidebar-scrollport] + span[aria-hidden="true"]'); node.style.display='block'; const r=node.getBoundingClientRect(), s=getComputedStyle(node); return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,background:s.backgroundImage,className:node.className}; })()`)
        assert(fadeBefore.display === 'block' && fadeBefore.height > 0 && fadeBefore.width > 0, 'before-fix reproduction paints the real opaque fade')
        await smokeFs.writeFile(smokeJoin(smokeDir, 'sidebar-fade-metrics.json'), JSON.stringify(fadeBefore,null,2)+'\n')
        await smokeDelay(150)
        await smokeFs.writeFile(smokeJoin(smokeDir, 'sidebar-fade-before.png'), (await window.webContents.capturePage()).toPNG())
        await page(`document.querySelector('[data-sidebar-scrollport] + span[aria-hidden="true"]').style.removeProperty('display')`)
        await smokeDelay(150)
        await smokeFs.writeFile(smokeJoin(smokeDir, 'frameless-main.png'), (await window.webContents.capturePage()).toPNG())
        await smokeFs.writeFile(smokeJoin(smokeDir, 'titlebar-macos.png'), (await window.webContents.capturePage()).toPNG())
        window.setAlwaysOnTop(false); settings.focus()
      }
      await evaluate(`(() => {
        const radius=document.getElementById('corner-radius'); radius.value='${stage === 0 ? 24 : 0}'; radius.dispatchEvent(new Event('input',{bubbles:true}));
        const trans=document.getElementById('sidebar-transparency'); trans.value='${stage === 0 ? 25 : 40}'; trans.dispatchEvent(new Event('input',{bubbles:true}));
        const style=document.getElementById('titlebar-style'); style.value='${stage === 0 ? 'windows' : 'macos'}'; style.dispatchEvent(new Event('change',{bubbles:true}));
        document.getElementById('system-shadow').checked=${stage !== 0};
        document.getElementById('sidebar-glass').checked=${stage === 0};
        document.getElementById('save').click();
      })()`)
      await until(async () => (await evaluate('window.dshClientSettings.get()')).value?.saved.cornerRadius === (stage === 0 ? 24 : 0))
      const saved = await evaluate('window.dshClientSettings.get()')
      assert(saved.value.saved.sidebarOpacity === (stage === 0 ? 75 : 60), 'transparency input saved with inverse opacity semantics')
      assert(saved.value.saved.titlebarStyle === (stage === 0 ? 'windows' : 'macos') && saved.value.current.titlebarStyle === expectedStyle, 'title-bar changes are saved for next restart, not applied live')
      assert(saved.value.current.cornerRadius === expectedRadius && saved.value.restartRequired, 'save preserves current-run appearance and requests restart')
      await smokeFs.writeFile(stageFile, JSON.stringify({stage:stage+1}))
      const restarted = await evaluate('window.dshClientSettings.restart()').catch(() => undefined)
      if (restarted !== undefined) assert(restarted.kind === 'ok', 'confirmed restart accepted')
    } catch (error) {
      await smokeFs.writeFile(smokeJoin(smokeDir, 'result.json'), JSON.stringify({ok:false,error:String(error.stack||error)},null,2)+'\n')
      console.error('CLIENT_SMOKE FAIL '+error.stack)
      smokeElectron.app.exit(1)
    }
  })
})
setTimeout(() => { console.error('CLIENT_SMOKE FAIL timeout'); smokeElectron.app.exit(2) }, 55000).unref()
