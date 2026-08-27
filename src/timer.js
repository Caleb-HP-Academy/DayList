/* global daylist, initTimerUI */
'use strict';
window.addEventListener('DOMContentLoaded', () => {
  initTimerUI(document.getElementById('timer-root'), { isPopout: true });
  document.getElementById('btn-min').addEventListener('click', () => daylist.minimize());
  document.getElementById('btn-close').addEventListener('click', () => daylist.close());
});
