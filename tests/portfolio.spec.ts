import { test, expect } from '@playwright/test';

async function openProjectModal(page: import('@playwright/test').Page) {
  await page.locator('.chest.chest-c1').click();
  await expect(page.locator('#modal')).toHaveClass(/open/);
}

test.describe('Portfolio interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#world')).toBeVisible();
  });

  test('navigates via top section links', async ({ page }) => {
    await page.locator('#hud a[href="#quests"]').click();
    await expect(page.locator('#quests')).toBeInViewport();

    await page.locator('#hud a[href="#treasures"]').click();
    await expect(page.locator('#treasures')).toBeInViewport();

    await page.locator('#hud a[href="#inventory"]').click();
    await expect(page.locator('#inventory')).toBeInViewport();

    await page.locator('#hud a[href="#guild"]').click();
    await expect(page.locator('#guild')).toBeInViewport();
  });

  test('quest expansion toggles open state', async ({ page }) => {
    const quest = page.locator('.quest-item').first();
    const hadOpen = await quest.evaluate((el) => el.classList.contains('open'));

    await quest.click();
    const isOpenAfterClick = await quest.evaluate((el) => el.classList.contains('open'));
    expect(isOpenAfterClick).toBe(!hadOpen);

    await quest.click();
    const isOpenAfterSecondClick = await quest.evaluate((el) => el.classList.contains('open'));
    expect(isOpenAfterSecondClick).toBe(hadOpen);
  });

  test('project modal opens, locks scroll, and closes', async ({ page }) => {
    await openProjectModal(page);

    const isBodyLocked = await page.evaluate(() =>
      document.body.classList.contains('modal-open-lock')
    );
    expect(isBodyLocked).toBeTruthy();

    await expect(page.locator('#modal-title')).toBeVisible();
    await page.locator('#modal .modal-close').click();
    await expect(page.locator('#modal')).not.toHaveClass(/open/);

    const isBodyUnlocked = await page.evaluate(() =>
      !document.body.classList.contains('modal-open-lock')
    );
    expect(isBodyUnlocked).toBeTruthy();
  });

  test('contact treasure modal opens and closes', async ({ page }) => {
    await page.evaluate(() => {
      if (typeof (window as any).openContactTreasure === 'function') {
        (window as any).openContactTreasure();
      }
    });
    await expect(page.locator('#contact-modal')).toHaveClass(/open/);
    await expect(page.locator('#contact-form')).toBeVisible();

    await page.locator('#contact-modal .modal-close').click();
    await expect(page.locator('#contact-modal')).not.toHaveClass(/open/);
  });

  test('mode toggle switches between pro and game modes', async ({ page }) => {
    const modeBtn = page.locator('#view-mode-toggle');

    await modeBtn.click();
    await expect(page.locator('body')).toHaveClass(/professional-mode/);
    await expect(page.locator('.pro-collectible')).toBeVisible();

    await modeBtn.click();
    await expect(page.locator('body')).not.toHaveClass(/professional-mode/);
  });

  test('pro mode: project modal stays viewport-bounded', async ({ page }) => {
    await page.locator('#view-mode-toggle').click();
    await expect(page.locator('body')).toHaveClass(/professional-mode/);

    await openProjectModal(page);

    const dims = await page.evaluate(() => {
      const modal = document.getElementById('modal');
      const box = document.getElementById('modal-box');
      if (!modal || !box) return null;
      const mr = modal.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      return {
        viewportH: window.innerHeight,
        viewportW: window.innerWidth,
        modalOpen: modal.classList.contains('open'),
        modalPosition: getComputedStyle(modal).position,
        modalH: mr.height,
        modalW: mr.width,
        boxH: br.height,
        boxW: br.width,
        bodyLocked: document.body.classList.contains('modal-open-lock')
      };
    });

    expect(dims).not.toBeNull();
    expect(dims!.modalOpen).toBeTruthy();
    expect(dims!.modalPosition).toBe('fixed');
    expect(dims!.bodyLocked).toBeTruthy();
    expect(dims!.modalH).toBeLessThanOrEqual(dims!.viewportH + 1);
    expect(dims!.modalW).toBeLessThanOrEqual(dims!.viewportW + 1);
    expect(dims!.boxH).toBeLessThanOrEqual(dims!.viewportH + 1);
    expect(dims!.boxW).toBeLessThanOrEqual(dims!.viewportW + 1);
  });
});
