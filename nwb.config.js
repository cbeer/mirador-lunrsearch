module.exports = {
  type: 'react-component',
  npm: {
    esModules: true,
    umd: {
      global: 'MiradorLunrSearch',
      externals: {
        react: 'React'
      }
    }
  }
}
