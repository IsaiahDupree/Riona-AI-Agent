import path from 'node:path'
import fs from 'node:fs'
import { logger } from '../utils/logger'
import { startRun, pushStep, finishRun } from '../trace/runtime'
import { saveTrace } from '../trace/store'
import { sendTraceEvent } from '../trace/webhook'
import { artifact } from '../trace/linkResolver'
import { InstagramAI } from './Instagram-AI'
import { postComment } from './Instagram-Core'

// Execute a single comment on a specific Instagram permalink with full tracing
export async function executeCommentOnPermalink(permalink: string, comment: string, username?: string, externalTrace?: any): Promise<void> {
  const trace = externalTrace ?? startRun({ action: 'instagram_execute_comment', target: { username, permalink }, cookieFile: './cookies.json' })
  let bot: InstagramAI | null = null
  try {
    await saveTrace(trace)
    await sendTraceEvent('run.updated', trace)

    bot = new InstagramAI()
    pushStep(trace, { name: 'init_browser', status: 'ok' })
    logger.info('[exec] initializing browser')
    await bot.initialize()
    logger.info('[exec] browser initialized ✅')

    const page = bot.getPage()
    if (!page) throw new Error('Browser page not initialized')

    pushStep(trace, { name: 'open_permalink', status: 'ok', notes: permalink })
    const tNav = Date.now()
    logger.info(`[exec] navigating to permalink ${permalink}`)
    console.log(`[exec] navigating to permalink ${permalink}`)
    try {
      pushStep(trace, { name: 'nav_start', status: 'ok', notes: permalink })
      // Log if navigation is slow
      const navSlow10s = setTimeout(() => { try { pushStep(trace, { name: 'nav_slow_10s', status: 'warn' }) } catch {} }, 10_000)
      await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 30000 })
      clearTimeout(navSlow10s)
      logger.info('[exec] goto done')
      console.log('[exec] goto done')
      pushStep(trace, { name: 'goto_done', status: 'ok' })
    } catch (e: any) {
      logger.warn(`[exec] goto failed ❌ ${e?.message || ''}`)
      console.log(`[exec] goto failed ❌ ${e?.message || ''}`)
      pushStep(trace, { name: 'goto_failed', status: 'error', notes: e?.message })
      throw e
    }

    logger.info('[exec] waiting for post UI (article or composer)')
    console.log('[exec] waiting for post UI (article or composer)')
    let uiReady = false
    try {
      pushStep(trace, { name: 'wait_article_start', status: 'ok' })
      const waitSlow10s = setTimeout(() => { try { pushStep(trace, { name: 'article_wait_slow_10s', status: 'warn' }) } catch {} }, 10_000)
      await page.waitForSelector('article', { timeout: 15000 })
      clearTimeout(waitSlow10s)
      uiReady = true
      pushStep(trace, { name: 'article_ready', status: 'ok' })
    } catch {
      logger.warn('[exec] article not found within 15s, trying composer selectors')
      console.log('[exec] article not found within 15s, trying composer selectors')
      pushStep(trace, { name: 'article_not_found', status: 'warn' })
      // Fallback: wait for comment composer elements that imply the post UI is loaded
      try {
        pushStep(trace, { name: 'wait_composer_start', status: 'ok' })
        const waitSlow10s = setTimeout(() => { try { pushStep(trace, { name: 'composer_wait_slow_10s', status: 'warn' }) } catch {} }, 10_000)
        await page.waitForFunction(() => !!(
          document.querySelector('form textarea') ||
          document.querySelector('textarea[aria-label="Add a comment…"]') ||
          document.querySelector('textarea[placeholder="Add a comment…"]') ||
          document.querySelector('textarea[placeholder="Add a comment..."]') ||
          document.querySelector('div[contenteditable="true"][role="textbox"]') ||
          document.querySelector('svg[aria-label="Comment"]')
        ), { timeout: 30000 })
        clearTimeout(waitSlow10s)
        uiReady = true
        pushStep(trace, { name: 'composer_ready', status: 'ok' })
      } catch (e: any) {
        logger.warn(`[exec] wait for composer failed ❌ ${e?.message || ''}`)
        console.log(`[exec] wait for composer failed ❌ ${e?.message || ''}`)
        pushStep(trace, { name: 'wait_composer_failed', status: 'error', notes: e?.message })
        throw e
      }
    }

    const navMs = Date.now() - tNav
    logger.info(`[exec] post UI ready ✅ (${navMs}ms from open_permalink)`) 
    console.log(`[exec] post UI ready ✅ (${navMs}ms from open_permalink)`) 
    try { pushStep(trace, { name: 'ui_ready', status: 'ok', notes: `${navMs}ms` }); await saveTrace(trace) } catch {}

    // Choose a container to scope comment search: prefer article, then main, else body
    let container = await page.$('article')
    if (!container) container = await page.$('main')
    if (!container) container = await page.$('body')
    if (!container) throw new Error('Could not find a container to operate in')

    // Capture screenshot artifact
    try {
      logger.info('[exec] capturing execute screenshot')
      const dir = path.join(process.cwd(), 'artifacts', trace.runId)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const fileName = `execute_${Date.now()}.png`
      const filePath = path.join(dir, fileName)
      await (container as any).screenshot({ path: filePath })
      trace.links = trace.links || ({} as any)
      trace.links.artifacts = [...(trace.links.artifacts || []), { title: 'Execute Screenshot', url: artifact(trace.runId, fileName) }]
      pushStep(trace, { name: 'post_scanned', status: 'ok', notes: JSON.stringify({ permalink }) })
      await saveTrace(trace)
      logger.info('[exec] screenshot saved ✅')
    } catch (e: any) {
      pushStep(trace, { name: 'screenshot_failed', status: 'warn', notes: e?.message })
      await saveTrace(trace)
      logger.warn(`[exec] screenshot failed ❌ ${e?.message || ''}`)
    }

    // Post the provided comment
    logger.info('[exec] starting comment detection and typing flow')
    try { pushStep(trace, { name: 'detect_comment_start', status: 'ok' }); await saveTrace(trace) } catch {}
    const result = await postComment(container as any, page, comment, true)
    if (result.success) {
      pushStep(trace, { name: 'comment_posted', status: 'ok', notes: JSON.stringify({ permalink, comment }) })
      logger.info('[exec] comment_posted ✅')
      finishRun(trace, true)
    } else {
      pushStep(trace, { name: 'comment_failed', status: 'error', notes: result.error })
      trace.error = { message: result.error || 'comment_failed' }
      logger.warn(`[exec] comment_failed ❌ ${result.error || ''}`)
      finishRun(trace, false)
    }
  } catch (error: any) {
    trace.error = { message: error?.message || 'Unknown error', stack: error?.stack }
    logger.error('[exec] executeCommentOnPermalink error', { err: error?.message })
    finishRun(trace, false)
  } finally {
    // Ensure browser is closed after the run completes
    if (bot) {
      try {
        await bot.close()
        try { pushStep(trace, { name: 'browser_closed', status: 'ok' }); await saveTrace(trace) } catch {}
      } catch {}
    }
    await saveTrace(trace)
    await sendTraceEvent('run.completed', trace)
  }
}
