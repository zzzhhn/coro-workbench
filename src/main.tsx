import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/500-italic.css';
import '@vexflow-fonts/bravura/index.css';
import App from './App';
import './styles.css';
import './workspace.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <main className="fatal-error">
          <h1>这页遇到了一点问题</h1>
          <p>已保存的工程仍保留在本机。刷新重试；若问题持续，可导出诊断信息。</p>
          <pre>{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()}>重新载入</button>
        </main>
      );
    return this.props.children;
  }
}

const root = import.meta.hot?.data.reactRoot ?? ReactDOM.createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.reactRoot = root;
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
