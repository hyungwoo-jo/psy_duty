let solverPromise = null;

function buildScriptUrl() {
  return new URL('../../vendor/javascript-lp-solver/solver.min.js', import.meta.url).href;
}

export function ensureSolver() {
  if (typeof window === 'undefined') {
    throw new Error('ILP solver는 브라우저 환경에서만 사용할 수 있습니다.');
  }
  if (window.solver) {
    return Promise.resolve(window.solver);
  }
  if (solverPromise) {
    return solverPromise;
  }
  const src = buildScriptUrl();
  solverPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      if (window.solver) {
        resolve(window.solver);
      } else {
        solverPromise = null;
        reject(new Error('LP solver 스크립트가 로드되었으나 window.solver를 찾을 수 없습니다.'));
      }
    };
    script.onerror = (event) => {
      solverPromise = null;
      reject(new Error(`LP solver 스크립트를 불러오지 못했습니다: ${event?.message || src}`));
    };
    document.head?.appendChild(script);
  });
  return solverPromise;
}
