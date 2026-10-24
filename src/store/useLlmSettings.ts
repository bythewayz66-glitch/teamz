import { useEffect, useState } from 'react';
import { getSettings, saveSettings, subscribeSettings, type LlmSettings } from '../api/settings';

/** React view of the browser-local LLM settings. */
export function useLlmSettings(): [LlmSettings, (next: LlmSettings) => void] {
  const [settings, setSettings] = useState<LlmSettings>(getSettings);
  useEffect(() => subscribeSettings(setSettings), []);
  return [settings, saveSettings];
}
