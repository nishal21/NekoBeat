import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PlayerProvider } from "./player/PlayerContext";
import { AppShell } from "./ui/AppShell";
import { BrowsePage } from "./ui/BrowsePage";
import { ExtensionsPage } from "./ui/ExtensionsPage";
import { HifiPage } from "./ui/HifiPage";
import { LibraryPage } from "./ui/LibraryPage";
import { LikedPage } from "./ui/LikedPage";
import { ListenPage } from "./ui/ListenPage";
import { SettingsPage } from "./ui/SettingsPage";

export default function App() {
  return (
    <PlayerProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<ListenPage />} />
            <Route path="browse" element={<BrowsePage />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="liked" element={<LikedPage />} />
            <Route path="hifi" element={<HifiPage />} />
            <Route path="extensions" element={<ExtensionsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PlayerProvider>
  );
}
