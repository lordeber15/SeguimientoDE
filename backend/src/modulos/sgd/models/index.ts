import { sequelize } from '../config/database';
import { Dependencia } from './Dependencia';
import { Empleado } from './Empleado';

Dependencia.belongsTo(Empleado, { foreignKey: 'coEmpleado', targetKey: 'cempCodemp', as: 'jefe' });
Dependencia.belongsTo(Dependencia, { foreignKey: 'coDepenPadre', targetKey: 'coDependencia', as: 'padre' });

export { sequelize, Dependencia, Empleado };
