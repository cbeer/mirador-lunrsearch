module.exports = {
  type: 'react-component',
  npm: {
    esModules: true,
    umd: {
      global: 'Mirador.LunrSearch',
      externals: {
        react: 'React'
      }
    }
  }
}
