import { createRoot } from 'react-dom/client';
import { Panel } from './Panel';
import './panel.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<Panel />);
