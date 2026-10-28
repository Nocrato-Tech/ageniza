import { configure } from '@testing-library/react';

// Every `findBy*` and `waitFor` of the suite stops waiting after this long (the library default is 1 s).
// The wait ends the moment the element is there, so a roomy bound adds no time to a passing test: it only
// decides how late a broken screen is reported. At 1 s the bound measured the machine instead of the
// screen: on a loaded 4-vCPU runner the first render of a page needs about that long (issue #746).
configure({ asyncUtilTimeout: 8000 });
