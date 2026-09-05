import Phaser from 'phaser'
import { WorldScene } from './game/WorldScene.js'
import { Bridge } from './net/bridge.js'
import { GameUI } from './ui/app.js'
import './styles.css'

const bridge = new Bridge()

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0f0c09',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  callbacks: {
    preBoot(bootGame) {
      const ui = new GameUI(bridge, bootGame)
      bootGame.registry.set('bridge', bridge)
      bootGame.registry.set('ui', ui)
    },
  },
  scene: [WorldScene],
})

void game
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {})
