import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorReporting } from './lib/errorReporting';
import { PRODUCT_NAME } from './lib/brand';
import './styles.css';

// The tab title comes from the same constant; index.html's <title> is only what shows before
// this script runs.
document.title = PRODUCT_NAME;

installGlobalErrorReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
