#!/usr/bin/env python3
"""bench.py: measure the demo and print a table. Also saves a still of each configuration.

    python tools/bench.py [--out out/bench] [--frames 120] [--software] [--voxel] [--tricks] [--weak]

Needs Playwright (pip install playwright; playwright install chromium). The page runs at 1920x1080 in headless
Chromium. For each configuration it asks the page for:
  - fragments per pixel, counted exactly by the additive count pass (demo.measure)
  - milliseconds per frame over N frames, each one waited for (demo.bench)
--software forces the CPU rasteriser (SwiftShader), where fill cost is not hidden by a fast GPU.
--voxel measures voxel mode instead: what it costs beside flat slices where both hold (street), and what each
shows where flat slices do not (level: nearly along the ground), then how many gaps flat slices open, tilt by tilt.
--weak is for slow GPUs: the street view at three internal resolutions, with the lighting of the high and of the low preset, with
hollow slices drawn whole and in strips, and in voxel mode. Add --software for a CPU rasteriser as a stand-in.
--tricks measures the faster ways to draw (voxel mode, impostors, skipping thin layers): each alone and all
together, against plain quads, with hidden-surface removal and shell stacks on throughout.
"""
import argparse, asyncio, json, os, pathlib
from playwright.async_api import async_playwright

VIEWS = ['overview', 'street']
RES = [('native', 'native 1920x1080'), (540, 'internal 960x540')]
ORDERS = [(0, 0, 'painter, whole stacks'), (0, 1, 'painter, shell stacks'), (1, 0, 'hidden-surface, whole stacks'), (1, 1, 'hidden-surface, shell stacks')]
# the faster ways: (voxel mode, impostors, skip thin layers, name), and where: (view, internal resolution divisor, name)
TRICKS = [(0, 0, 0, 'flat quads (none)'), (1, 0, 0, 'voxel mode (each slice a box with sides)'), (0, 1, 0, 'impostors'), (0, 0, 1, 'skip thin layers'), (1, 1, 0, 'voxel mode + impostors'), (1, 1, 1, 'all three')]
PLACES = [('overview', 'native', 'overview, 1920x1080'), ('street', 'native', 'street, 1920x1080'), ('far', 360, 'far (whole map small), internal 640x360')]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out/bench')
    ap.add_argument('--frames', type=int, default=120)
    ap.add_argument('--software', action='store_true')
    ap.add_argument('--voxel', action='store_true')
    ap.add_argument('--tricks', action='store_true')
    ap.add_argument('--weak', action='store_true')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    url = (pathlib.Path(__file__).resolve().parent.parent / 'index.html').as_uri() + '?hold'
    gpu = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] if a.software else ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
    rows = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=gpu)
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto(url)
        try:
            await page.wait_for_function('window.demo && window.demo.ready', timeout=20000)
        except Exception:
            print('the page did not start; errors:', errors[:5])
            raise SystemExit(1)
        if a.weak:
            print('renderer:', await page.evaluate('demo.engine.renderer'))
            print('| internal | preset | drawn as | quads or boxes | written avg | covered avg | ms/frame |')
            print('| --- | --- | --- | ---: | ---: | ---: | ---: |')
            for res, rname in [('native', '1920x1080'), (540, '960x540'), (360, '640x360')]:
                for q in ['high', 'low']:
                    for vox, split, how in [(0, False, 'flat quads, slices whole'), (0, True, 'flat quads, hollow slices in strips'), (1, True, 'voxel mode')]:
                        await page.evaluate('(c) => demo.set(c)', {'view': 'street', 'q': q, 'res': res, 'hsr': True, 'shell': True, 'heat': 0, 'measure': False, 'voxel': vox, 'split': split, 'lod': False, 'impostors': False})
                        m = await page.evaluate('demo.measure(0)')
                        ms = await page.evaluate('(n) => demo.bench(n)', a.frames)
                        print('| %s | %s | %s | %d | %.2f | %.1f | %.2f |' % (rname, q, how, m['quads'], m['written']['avg'], m['covered']['avg'], ms), flush=True)
            # the presets as the page applies them (low and med switch voxel mode on at street level by themselves)
            for q in ['none', 'low', 'med', 'high']:
                await page.evaluate('(c) => demo.set(c)', {'view': 'street', 'q': 'high', 'voxel': -1, 'split': False})
                await page.evaluate('(c) => demo.set(c)', {'q': q} if q != 'none' else {'res': 360})
                m = await page.evaluate('demo.measure(0)')
                ms = await page.evaluate('(n) => demo.bench(n)', a.frames)
                print('| %dx%d | preset %s | %s | %d | %.2f | %.1f | %.2f |' % (m['internal'][0], m['internal'][1], q if q != 'none' else '(the default)', 'voxel mode' if m['voxel'] else 'flat quads', m['quads'], m['written']['avg'], m['covered']['avg'], ms), flush=True)
            await browser.close()
            return
        if a.tricks:
            rows = []
            for view, res, place in PLACES:
                for vox, imp, lod, name in TRICKS:
                    await page.evaluate('(c) => demo.set(c)', {'view': view, 'res': res, 'hsr': True, 'shell': True, 'heat': 0, 'measure': False, 'voxel': vox, 'impostors': bool(imp), 'lod': bool(lod)})
                    await page.evaluate('demo.seek(0)'); await page.wait_for_timeout(300)      # impostors are baked on the first frame
                    m = await page.evaluate('demo.measure(0)')
                    ms = await page.evaluate('(n) => demo.bench(n)', a.frames)
                    rows.append(dict(place=place, name=name, ms=ms, **m))
                    await page.evaluate('demo.seek(0)'); await page.screenshot(path=os.path.join(a.out, 'tricks-%s-%d%d%d.png' % (view, vox, imp, lod)))
            await browser.close()
            print('renderer:', rows[0]['renderer'], '| errors:', errors[:5])
            print('| view | drawn as | quads or boxes | written avg | covered avg | covered max | ms/frame |')
            print('| --- | --- | ---: | ---: | ---: | ---: | ---: |')
            for r in rows:
                print('| %s | %s | %d | %.2f | %.1f | %d | %.2f |' % (r['place'], r['name'], r['quads'], r['written']['avg'], r['covered']['avg'], r['covered']['max'], r['ms']))
            return
        if a.voxel:
            print('renderer:', await page.evaluate('demo.engine.renderer'))
            print('| view | drawn as | quads or boxes | written avg | covered avg | gaps | ms/frame |')
            print('| --- | --- | ---: | ---: | ---: | ---: | ---: |')
            for view, name in [('overview', 'overview, tilt 41'), ('street', 'street, tilt 25'), ('level', 'level, tilt 8')]:
                for vox, how in [(0, 'flat slices'), (1, 'voxel mode')]:
                    await page.evaluate('(c) => demo.set(c)', {'view': view, 'res': 'native', 'hsr': True, 'shell': True, 'heat': 0, 'measure': False, 'voxel': vox, 'unclamped': True})
                    m = await page.evaluate('demo.measure(0)')
                    ms = await page.evaluate('(n) => demo.bench(n)', a.frames)
                    g = await page.evaluate('demo.holes(0)')
                    await page.evaluate('(c) => demo.set(c)', {'voxel': vox}); await page.evaluate('demo.seek(0)'); await page.screenshot(path=os.path.join(a.out, 'voxel-%s-%d.png' % (view, vox)))
                    print('| %s | %s | %d | %.2f | %.1f | %s | %.2f |' % (name, how, m['quads'], m['written']['avg'], m['covered']['avg'], '%.2f%%' % (g['gaps'] * 100) if not vox else '0', ms))
            print()
            print('| tilt | parallel camera (village) | perspective camera (street) |')
            print('| ---: | ---: | ---: |')
            for deg in [60, 45, 30, 27, 24, 21, 18, 15, 12, 9, 6, 3]:
                out = []
                for view in ['village', 'street']:
                    await page.evaluate('(c) => demo.set(c)', {'view': view, 'pitch': deg * 3.14159265 / 180, 'voxel': 0})
                    out.append((await page.evaluate('demo.holes(0)'))['gaps'] * 100)
                print('| %d | %.2f%% | %.2f%% |' % (deg, out[0], out[1]))
            await browser.close()
            return
        for view in VIEWS:
            for res, res_name in RES:
                for hsr, shell, name in ORDERS:
                    cfg = {'view': view, 'res': res, 'hsr': bool(hsr), 'shell': bool(shell), 'heat': 0, 'measure': False, 'voxel': 0}
                    await page.evaluate('(c) => demo.set(c)', cfg)
                    m = await page.evaluate('demo.measure(0)')
                    ms = await page.evaluate('(n) => demo.bench(n)', a.frames)
                    rows.append(dict(view=view, res=res_name, order=name, ms=ms, **m))
                    tag = '%s-res%s-hsr%d-shell%d' % (view, res, hsr, shell)
                    await page.evaluate('demo.seek(0)'); await page.screenshot(path=os.path.join(a.out, tag + '.png'))
                    await page.evaluate('(c) => { demo.set(c); demo.measure(0); }', {'heat': 1}); await page.screenshot(path=os.path.join(a.out, tag + '-heat.png'))
        await browser.close()
    json.dump(rows, open(os.path.join(a.out, 'bench.json'), 'w'), indent=1)
    print('renderer:', rows[0]['renderer'], '| errors:', errors[:5])
    print('| view | resolution | order | quads | written avg | written max | covered avg | covered max | ms/frame |')
    print('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
    for r in rows:
        print('| %s | %s | %s | %d | %.2f | %d | %.1f | %d | %.2f |' % (r['view'], r['res'], r['order'], r['quads'], r['written']['avg'], r['written']['max'], r['covered']['avg'], r['covered']['max'], r['ms']))

asyncio.run(main())
