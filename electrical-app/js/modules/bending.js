// Pipe bending: offsets, kicks, saddles, 90s, back-to-backs, box offsets,
// rolling and segment bends, with a drawn diagram and the marks for the pipe.
export default {
  id: 'bending',
  title: 'Pipe bending',
  icon: 'wrench',
  group: 'field',
  perm: 'calcs',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Pipe bending' },
      ui.empty({ icon: 'wrench', title: 'Coming soon', text: 'Offsets, kicks, saddles, 90s and back-to-backs with the marks to put on the pipe.' })));
  },
};
