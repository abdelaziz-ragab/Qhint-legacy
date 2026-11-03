import { desktopCapturer, dialog, shell, systemPreferences } from 'electron';

const SCREEN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * macOS needs Screen Recording permission; without it captures only show the wallpaper.
 * Returns true when capture can proceed. Windows needs no permission.
 */
export async function ensureScreenPermission(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return true;

  if (status === 'not-determined') {
    // First request shows the system prompt.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true;
  }

  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'Qhint needs Screen Recording permission',
    detail:
      'Qhint looks at your screen to show where to click next. Screenshots are never stored on ' +
      'our servers.\n\nEnable Qhint in System Settings → Privacy & Security → ' +
      'Screen Recording, then restart Qhint. (In development, enable the terminal app you launched it from.)',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await shell.openExternal(SCREEN_SETTINGS_URL);
  return false;
}
