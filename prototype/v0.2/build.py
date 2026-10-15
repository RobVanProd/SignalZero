from pathlib import Path
root=Path(__file__).resolve().parent
html=(root/'src/index.template.html').read_text()
sim=(root/'src/simulation.js').read_text()
game=(root/'src/game.js').read_text()
assert '/*__SIM__*/' in html and '/*__GAME__*/' in html
html=html.replace('/*__SIM__*/',sim).replace('/*__GAME__*/',game)
(root/'SIGNAL_ZERO_3D.html').write_text(html)
print('Built:',root/'SIGNAL_ZERO_3D.html',len(html),'bytes')
