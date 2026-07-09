// ABOUTME: Popup React entry — mounts the Popup component into the extension action popup.
// ABOUTME: The popup only messages the service worker; it performs no board/UploadThing network calls itself.
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup';

createRoot(document.getElementById('root')!).render(<Popup />);
