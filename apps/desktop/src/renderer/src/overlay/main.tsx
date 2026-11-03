import { createRoot } from 'react-dom/client';
import { Overlay } from './Overlay';
import './overlay.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<Overlay />);
