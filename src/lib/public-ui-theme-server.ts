import { headers } from "next/headers";
import {
  DEFAULT_PUBLIC_UI_THEME,
  PUBLIC_UI_THEME_HEADER,
  parsePublicUiTheme,
  type PublicUiTheme,
} from "@/lib/public-ui-theme";

export async function getPublicUiTheme(): Promise<PublicUiTheme> {
  try {
    const h = await headers();
    return parsePublicUiTheme(h.get(PUBLIC_UI_THEME_HEADER));
  } catch {
    return DEFAULT_PUBLIC_UI_THEME;
  }
}
