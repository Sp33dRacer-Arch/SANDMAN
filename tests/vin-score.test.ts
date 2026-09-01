import { describe, expect, it } from 'vitest';
import { isValidFullVin, scoreVinCandidate } from '../src/services/vin.service';

describe('VIN helpers', () => {
  it('validates full VIN characters', () => {
    expect(isValidFullVin('WBA1A11010J123456')).toBe(true);
    expect(isValidFullVin('WBA1A11010I123456')).toBe(false);
  });
  it('scores matching make/model/year/engine strongly', () => {
    const score = scoreVinCandidate({ vin:'WBA1A11010J123456', make:'BMW', model:'M140i', modelYear:2018, trim:null, series:null, engineModel:'B58', displacementL:3, cylinders:6, fuelType:'Gasoline', driveType:null, bodyClass:null, vehicleType:null, errorCode:null, errorText:null }, { yearStart:2016, yearEnd:2019, trim:null, engineCode:'B58B30M0', engineName:'B58 3.0 Turbo', displacementCc:2998, model:{ name:'M140i', make:{ name:'BMW' } } });
    expect(score.score).toBeGreaterThanOrEqual(90);
  });
});
